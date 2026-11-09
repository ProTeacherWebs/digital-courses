import { connection } from "next/server";
import * as XLSX from "xlsx";
import { readKnowledgeFile } from "./knowledge";

export type Course = {
  title: string;
  direction: string;
  description: string;
  duration: string;
  format: string;
  price: number;
  oldPrice: number | null;
  teacher: string;
  age: string;
};

export type Teacher = {
  name: string;
  role: string;
  experience: string;
  description: string;
};

const text = (value: unknown) => String(value ?? "").trim();

function number(value: unknown): number | null {
  const parsed = Number(text(value).replace(/[\s₽]/g, "").replace(",", "."));
  return text(value) !== "" && Number.isFinite(parsed) ? parsed : null;
}

function rows(workbook: XLSX.WorkBook, sheet: string) {
  const worksheet = workbook.Sheets[sheet];
  return worksheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet) : [];
}

// Читается при каждом запросе из той же базы знаний (Google Drive или папка knowledge/): правки в таблице быстро видны на сайте.
export async function getCatalog(): Promise<{ courses: Course[]; teachers: Teacher[] }> {
  await connection();
  const workbook = XLSX.read(await readKnowledgeFile("catalog.xlsx"));

  const courses = rows(workbook, "Курсы").flatMap((row) => {
    const price = number(row["Цена"]);
    if (!text(row["Название"]) || price === null) return [];
    return [
      {
        title: text(row["Название"]),
        direction: text(row["Направление"]),
        description: text(row["Описание"]),
        duration: text(row["Длительность"]),
        format: text(row["Формат"]),
        price,
        oldPrice: number(row["Старая цена"]),
        teacher: text(row["Преподаватель"]),
        age: text(row["Возраст"]),
      },
    ];
  });

  const teachers = rows(workbook, "Преподаватели").flatMap((row) =>
    text(row["Имя"])
      ? [
          {
            name: text(row["Имя"]),
            role: text(row["Роль"]),
            experience: text(row["Опыт"]),
            description: text(row["Описание"]),
          },
        ]
      : [],
  );

  return { courses, teachers };
}
