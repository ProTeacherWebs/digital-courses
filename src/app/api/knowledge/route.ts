import { readFile } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_DIR, SUPPORTED } from "@/lib/knowledge";

const TYPES: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
};

// Отдаёт файл из knowledge/ по ссылке из ответа ассистента. Выйти за пределы папки нельзя.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("file") ?? "";
  const full = path.resolve(KNOWLEDGE_DIR, name);
  const ext = path.extname(full).toLowerCase();

  if (!name || !full.startsWith(KNOWLEDGE_DIR + path.sep) || !SUPPORTED.includes(ext)) {
    return new Response("Не найдено", { status: 404 });
  }

  try {
    const data = await readFile(full);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": TYPES[ext],
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Не найдено", { status: 404 });
  }
}
