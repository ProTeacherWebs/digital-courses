import path from "node:path";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import * as XLSX from "xlsx";
import { getKnowledgeFiles, type KnowledgeFile } from "./knowledge";

const CHUNK_SIZE = 900;

type Chunk = { source: string; text: string; terms: Map<string, number>; length: number };
type Index = { signature: string; chunks: Chunk[]; df: Map<string, number>; avgLength: number };

export type Hit = { source: string; text: string; score: number };

function sheetsToText(buffer: Buffer): string {
  const workbook = XLSX.read(buffer);
  return workbook.SheetNames.flatMap((name) =>
    XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name]).map((row) => {
      const cells = Object.entries(row)
        .filter(([, value]) => String(value ?? "").trim() !== "")
        .map(([key, value]) => `${key}: ${String(value).trim()}`);
      return `[${name}] ${cells.join("; ")}`;
    }),
  ).join("\n");
}

async function readText(name: string, buffer: Buffer): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") {
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
    return text;
  }
  if (ext === ".docx") return (await mammoth.extractRawText({ buffer })).value;
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") return sheetsToText(buffer);
  return buffer.toString("utf8");
}

// Режет текст по строкам примерно на CHUNK_SIZE символов; последняя строка повторяется в следующем фрагменте.
export function chunkText(text: string): string[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => (line.length > CHUNK_SIZE * 1.5 ? line.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "g")) ?? [] : [line]));

  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [current[current.length - 1]];
      size = current[0].length;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

const STOP = new Set(
  "и в во на с со по для что как это у вы вас вам мы нас не а но или то же ли бы от до из за к о об при про есть ли кто какой какие какая какое какую каких сколько где когда можно нужно ли".split(" "),
);

// Слова, которые есть почти в каждом фрагменте и не помогают искать (после обрезки до 4 букв).
const STEM_STOP = new Set(["курс", "веде", "школ", "преп", "учит", "обуч"]);

// Близкие по смыслу слова сводим к одному термину, чтобы «вернуть деньги» находило «возврат».
const ALIAS: Record<string, string> = { верн: "возв", цена: "стои", цены: "стои", цену: "стои", цен: "стои", рубл: "стои" };

// Слова режутся до первых 4 букв: «курсы», «курсов», «курса» становятся одним термином «курс».
function tokenize(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((word) => !STOP.has(word))
    .map((word) => (/^\p{N}+$/u.test(word) ? word : word.slice(0, 4)))
    .map((term) => ALIAS[term] ?? term)
    .filter((term) => !STEM_STOP.has(term));
}

async function build(signature: string, files: KnowledgeFile[]): Promise<Index> {
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  // Файлы скачиваются параллельно: с Google Drive это заметно быстрее, чем по одному.
  const buffers = await Promise.all(files.map((file) => file.read()));
  for (const [i, file] of files.entries()) {
    const source = file.name;
    const raw = await readText(file.name, buffers[i]);
    // Каждая строка таблицы — отдельный фрагмент: так цена и преподаватель курса не смешиваются с другими курсами.
    const pieces = [".xlsx", ".xls", ".csv"].includes(path.extname(file.name).toLowerCase()) ? raw.split("\n").filter(Boolean) : chunkText(raw);
    for (const text of pieces) {
      const tokens = tokenize(`${source} ${text}`);
      const terms = new Map<string, number>();
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
      for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
      chunks.push({ source, text, terms, length: tokens.length });
    }
  }
  const avgLength = chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1);
  return { signature, chunks, df, avgLength };
}

// Индекс живёт в памяти процесса и пересобирается, когда меняется состав или версия файлов (локальных или на Drive).
const store = globalThis as unknown as { __ragIndex?: Promise<Index> };

async function getIndex(): Promise<Index> {
  const files = await getKnowledgeFiles();
  const signature = files.map((file) => `${file.name}:${file.version}`).join("|");

  const current = store.__ragIndex;
  if (current) {
    const index = await current.catch(() => null);
    if (index?.signature === signature) return index;
  }
  const next = build(signature, files);
  store.__ragIndex = next;
  try {
    return await next;
  } catch (error) {
    store.__ragIndex = undefined;
    throw error;
  }
}

// Поиск BM25: работает локально, без внешних сервисов и лимитов.
export async function search(query: string, limit = 6): Promise<Hit[]> {
  const index = await getIndex();
  const words = [...new Set(tokenize(query))];
  const total = index.chunks.length;
  const k1 = 1.5;
  const b = 0.75;

  return index.chunks
    .map((chunk) => {
      let score = 0;
      for (const word of words) {
        const tf = chunk.terms.get(word);
        if (!tf) continue;
        const n = index.df.get(word) ?? 0;
        const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.length) / index.avgLength));
      }
      return { source: chunk.source, text: chunk.text, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
