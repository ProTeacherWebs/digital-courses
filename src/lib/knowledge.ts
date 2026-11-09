import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
export const SUPPORTED = [".md", ".txt", ".pdf", ".docx", ".xlsx", ".xls", ".csv"];

export type KnowledgeFile = { name: string; version: string; read: () => Promise<Buffer> };

const LISTING_TTL = 5 * 60_000;
const RETRY_AFTER_ERROR = 30_000;
const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";

// Документы и таблицы Google отдаются в Word и Excel, остальные файлы скачиваются как есть.
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
};

const store = globalThis as unknown as {
  __driveToken?: { value: string; expires: number };
  __knowledge?: { at: number; files: KnowledgeFile[]; ttl: number };
  __driveContent?: Map<string, Buffer>;
};

function credentials(): { email: string; key: string } | null {
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (file) {
    const json = JSON.parse(readFileSync(path.resolve(process.cwd(), file), "utf8"));
    return { email: json.client_email, key: json.private_key };
  }
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  return email && key ? { email, key } : null;
}

function driveFolder(): string | null {
  return process.env.GOOGLE_DRIVE_FOLDER_ID && credentials() ? process.env.GOOGLE_DRIVE_FOLDER_ID : null;
}

async function accessToken(): Promise<string> {
  const cached = store.__driveToken;
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;

  const creds = credentials();
  if (!creds) throw new Error("Не заданы ключи сервисного аккаунта Google");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: creds.email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(creds.key).toString("base64url");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!response.ok) throw new Error(`Google не выдал токен (${response.status})`);
  const data = await response.json();
  store.__driveToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function driveFetch(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!response.ok) throw new Error(`Google Drive ответил ${response.status}`);
  return response;
}

// Содержимое хранится в памяти по паре «файл + версия»: скачивается только после изменения файла.
async function download(key: string, url: string): Promise<Buffer> {
  const cache = (store.__driveContent ??= new Map());
  const hit = cache.get(key);
  if (hit) return hit;
  const data = Buffer.from(await (await driveFetch(url)).arrayBuffer());
  if (cache.size > 100) cache.clear();
  cache.set(key, data);
  return data;
}

async function listDrive(folderId: string, prefix = ""): Promise<KnowledgeFile[]> {
  const files: KnowledgeFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum)",
      pageSize: "200",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await driveFetch(`${API}?${params}`)).json();

    for (const file of data.files ?? []) {
      if (file.mimeType === FOLDER) {
        files.push(...(await listDrive(file.id, `${prefix}${file.name}/`)));
        continue;
      }
      const exported = EXPORTS[file.mimeType];
      let name = prefix + file.name;
      if (exported && !name.toLowerCase().endsWith(exported.ext)) name += exported.ext;
      if (!SUPPORTED.includes(path.extname(name).toLowerCase())) continue;

      const version: string = file.md5Checksum ?? file.modifiedTime;
      const url = exported
        ? `${API}/${file.id}/export?mimeType=${encodeURIComponent(exported.mime)}`
        : `${API}/${file.id}?alt=media&supportsAllDrives=true`;
      files.push({ name, version, read: () => download(`${file.id}:${version}`, url) });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function listLocal(dir = KNOWLEDGE_DIR, prefix = ""): Promise<KnowledgeFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<KnowledgeFile[]> => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listLocal(full, `${prefix}${entry.name}/`);
      if (!SUPPORTED.includes(path.extname(entry.name).toLowerCase())) return [];
      const info = await stat(full);
      return [{ name: prefix + entry.name, version: `${info.size}:${info.mtimeMs}`, read: () => readFile(full) }];
    }),
  );
  return nested.flat().sort((a, b) => a.name.localeCompare(b.name));
}

// Источник знаний: папка Google Drive, если заданы ключи; иначе или при сбое Drive — локальная папка knowledge/.
export async function getKnowledgeFiles(): Promise<KnowledgeFile[]> {
  const folder = driveFolder();
  if (!folder) return listLocal();

  const cached = store.__knowledge;
  if (cached && Date.now() - cached.at < cached.ttl) return cached.files;

  try {
    const files = await listDrive(folder);
    if (files.length > 0) {
      store.__knowledge = { at: Date.now(), files, ttl: LISTING_TTL };
      return files;
    }
    console.warn("Папка Google Drive пуста, используется локальная knowledge/");
  } catch (error) {
    console.error("Google Drive недоступен:", error instanceof Error ? error.message : error);
    if (cached) {
      store.__knowledge = { ...cached, at: Date.now(), ttl: RETRY_AFTER_ERROR };
      return cached.files;
    }
  }
  const local = await listLocal();
  store.__knowledge = { at: Date.now(), files: local, ttl: RETRY_AFTER_ERROR };
  return local;
}

export function resetKnowledgeCache() {
  store.__knowledge = undefined;
}

export async function readKnowledgeFile(name: string): Promise<Buffer> {
  const file = (await getKnowledgeFiles()).find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!file) throw new Error(`Файл ${name} не найден в базе знаний`);
  return file.read();
}
