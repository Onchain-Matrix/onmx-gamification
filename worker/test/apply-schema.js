import { readFileSync } from "node:fs";
import { join } from "node:path";

export async function applySchema(db) {
  const sql = readFileSync(join(process.cwd(), "migrations/0001_init.sql"), "utf8");
  // strip PRAGMA for batch; execute statements
  const parts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--") && !/^PRAGMA/i.test(s));
  for (const stmt of parts) {
    await db.prepare(stmt).run();
  }
}
