import { SCHEMA_SQL } from "./schema.sql.js";

export async function applyMigrations(db) {
  const cleaned = SCHEMA_SQL.split("\n")
    .map((l) => (l.trim().startsWith("--") ? "" : l))
    .join("\n");
  const parts = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA/i.test(s));
  for (const stmt of parts) {
    await db.prepare(stmt).run();
  }
}
