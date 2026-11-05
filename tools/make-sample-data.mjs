// Writes data/sample-roster.json + data/sample-tasks.json — SYNTHETIC ONLY.
import { writeFileSync } from "node:fs";
import { makeAccounts, makeTasks } from "../sim/synth.js";
const accounts = makeAccounts(120, 42).map(({ activity, ...a }) => a);
const tasks = makeTasks(makeAccounts(120, 42), "2026-10-01", 35, 7);
const meta = { SYNTHETIC: true, note: "FAKE sample rows for layout/testing. Not real ONMX members; handles are placeholders.", generatedBy: "tools/make-sample-data.mjs seed=42/7", asOf: "2026-11-05" };
writeFileSync("data/sample-roster.json", JSON.stringify({ meta, accounts }, null, 1));
writeFileSync("data/sample-tasks.json", JSON.stringify({ meta, tasks }));
console.log(accounts.length, "accounts", tasks.length, "tasks");
