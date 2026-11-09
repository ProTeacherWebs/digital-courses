import { timingSafeEqual } from "node:crypto";
import { getKnowledgeFiles, resetKnowledgeCache } from "@/lib/knowledge";

function authorized(request: Request): boolean {
  const secret = process.env.REINDEX_SECRET;
  const given = request.headers.get("x-reindex-secret") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

// Сбрасывает кэш списка файлов и перечитывает базу знаний. Индекс пересоберётся при следующем вопросе.
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Нет доступа" }, { status: 401 });
  resetKnowledgeCache();
  const files = await getKnowledgeFiles();
  return Response.json({ count: files.length, files: files.map((file) => file.name) });
}
