// OFFLINE roster exporter interface (DESIGNED, INACTIVE). No credentials, no network, no real roster in repo.
// Intended daily flow (NOT enabled): Gamification bot exports Notion roster to a LOCAL JSON file outside the repo,
// then runs: node tools/export-roster.mjs --in <file> --out data/roster.json --visibility <everyone|optin>
// The Notion fetch itself is deliberately NOT implemented here (see NotionRosterSource).
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG } from "../src/config.js";
import { xLink } from "../src/engine.js";

export class NotionRosterSource { // interface stub — implement only after owner approval; never commit tokens.
  async fetchRows() { throw new Error("NotionRosterSource not implemented (inactive by design)"); }
}
// Fields allowed out of Notion. Anything else (emails, wallets, seed $, notes) is dropped.
const ALLOWED = ["account", "handle", "optIn", "seedUsd", "verifierDate"];
export function transform(rows, visibility) {
  if (!["everyone", "optin"].includes(visibility)) throw new Error("visibility policy UNDECIDED: pass --visibility everyone|optin after owner decision");
  const seen = new Set(); const out = []; const dropped = [];
  for (const r of rows) {
    if (!r || !r.account || seen.has(r.account)) { dropped.push({ r: r?.account, reason: "missing/duplicate" }); continue; }
    if (!xLink(r.handle)) { dropped.push({ r: r.account, reason: "invalid handle" }); continue; }
    if (visibility === "optin" && r.optIn !== true) { dropped.push({ r: r.account, reason: "not opted in" }); continue; }
    seen.add(r.account); out.push(Object.fromEntries(ALLOWED.filter(k => k in r).map(k => [k, r[k]])));
  }
  // NOTE: seedUsd is used only to pick a multiplier band and should NOT be shown publicly (ASSUMPTION; owner to confirm).
  return { accounts: out, dropped };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map(s => s.trim().split(/\s+/)));
  const vis = a.visibility || CONFIG.VISIBILITY;
  const rows = JSON.parse(readFileSync(a.in, "utf8"));
  const res = transform(Array.isArray(rows) ? rows : rows.accounts, vis);
  if (a.dry !== undefined || !a.out) { console.log(JSON.stringify({ kept: res.accounts.length, dropped: res.dropped.length })); }
  else writeFileSync(a.out, JSON.stringify({ meta: { SYNTHETIC: false, visibility: vis }, accounts: res.accounts }, null, 1));
}
