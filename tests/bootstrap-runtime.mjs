/**
 * Runtime / module-integration regression (Node harness — not a real browser).
 * Catches empty-main failures unit helper tests missed:
 *  1) index.html named imports/bindings must exist on target modules
 *  2) dashboard bootstrap must execute to BOOT_OK and fill key DOM (+ ?ref= form)
 *  3) ASSET_V / ASSET_BASE dynamic-import cache-bust markers must stay present
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const results = [];
const ok = (c, m) => { if (!c) throw new Error(m || "assert"); };
function t(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.message }); }
}

function extractImportExpectations(src) {
  const named = [];
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'](\.?\/?src\/[^"'?]+)/g)) {
    const mod = m[2].replace(/^\.\//, "");
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      named.push({ mod, id: p.split(/\s+as\s+/).pop().trim() });
    }
  }
  for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*ASSET_BASE\s*\+\s*["'](src\/[^"']+)/g)) {
    const mod = m[2].split("?")[0];
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      named.push({ mod, id: p.split(/\s+as\s+/).pop().trim() });
    }
  }
  const namespaces = [];
  for (const m of src.matchAll(/import\s*\*\s*as\s*(\w+)\s*from\s*["'](\.?\/?src\/[^"'?]+)/g)) {
    namespaces.push({ mod: m[2].replace(/^\.\//, ""), as: m[1] });
  }
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*await\s+import\(\s*ASSET_BASE\s*\+\s*["'](src\/[^"']+)/g)) {
    namespaces.push({ mod: m[2].split("?")[0], as: m[1] });
  }
  return { named, namespaces };
}

t("index bootstrap uses dynamic import + ASSET_V cache-bust + root ASSET_BASE", () => {
  ok(/const ASSET_V\s*=/.test(html), "ASSET_V missing");
  ok(/const ASSET_BASE\s*=\s*["']\/onmx-gamification\//.test(html), "ASSET_BASE missing");
  ok(/await import\(ASSET_BASE\s*\+\s*["']src\/config\.js\?v=["']\s*\+\s*ASSET_V\)/.test(html), "config dynamic import");
  ok(/await import\(ASSET_BASE\s*\+\s*["']src\/engine\.js\?v=["']\s*\+\s*ASSET_V\)/.test(html), "engine dynamic import");
  ok(/await import\(ASSET_BASE\s*\+\s*["']src\/referral\.js\?v=["']\s*\+\s*ASSET_V\)/.test(html), "referral dynamic import");
  ok(/fetch\(ASSET_BASE\s*\+\s*u\s*\+\s*["']\?v=["']\s*\+\s*ASSET_V\)/.test(html), "JSON fetch cache-bust");
  ok(/async function __onmxMain/.test(html) && /__onmxMain\(\)/.test(html), "__onmxMain wrapper");
  ok(/Dashboard failed to load/.test(html), "visible bootstrap error UI");
  ok(!/import\s*\{[^}]+\}\s*from\s*["']\.\/src\//.test(html), "no static relative named imports");
});

t("Node DOM harness: bootstrap fills season/prize/out; ?ref= referral gated off; clean empty board", () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const body = script
    .replace(/const ASSET_BASE\s*=\s*["']\/onmx-gamification\/["']\s*;/,
      `const ASSET_BASE = ${JSON.stringify(pathToFileURL(root + "/").href)};`)
    .replace(/fetch\(ASSET_BASE\s*\+\s*u\s*\+\s*["']\?v=["']\s*\+\s*ASSET_V\)/g,
      `fetch(new URL(u, ASSET_BASE).href)`);

  const dir = mkdtempSync(join(tmpdir(), "onmx-boot-"));
  const bootPath = join(dir, "boot.mjs");
  const harness = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
globalThis.fetch = async (u) => {
  const href = String(u);
  if (/onmx-gamification-claims\.onmx\.workers\.dev/.test(href)) {
    const body = JSON.stringify({
      ok: true,
      policyVersion: "claims-policy-v1",
      readiness: { xLoginEnabled: false, productionGrantsEnabled: false, receiptVerification: "decoder_implemented_grants_off", sessionSecrets: true },
      receipts: { available: true, acceptsFakeFixtures: false, productionGrantsEnabled: false },
      blockers: ["X OAuth app secrets not configured (X_CLIENT_ID / X_CLIENT_SECRET / X_REDIRECT_URI)"]
    });
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  const url = new URL(u, pathToFileURL(${JSON.stringify(root + "/")}).href);
  const path = url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
  const body = readFileSync(path, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
};
const el = () => {
  const o = {
    innerHTML: "", textContent: "", hidden: false, value: "", style: {},
    classList: { toggle(){}, add(){}, remove(){} }, dataset: {},
    setAttribute(){}, onclick: null, onsubmit: null, oninput: null,
    querySelector(){ return el(); }, querySelectorAll(){ return []; },
    prepend(n){ this.innerHTML = ((n && n.innerHTML) || "") + this.innerHTML; },
    appendChild(n){ this.innerHTML += (n && n.innerHTML) || ""; this._kids = this._kids || []; this._kids.push(n); },
    select(){},
  };
  return o;
};
const els = new Map();
globalThis.document = {
  getElementById(id){ if(!els.has(id)) els.set(id, el()); return els.get(id); },
  querySelectorAll(){ return []; },
  createElement(){ return el(); },
  addEventListener(){},
  body: el(),
};
globalThis.localStorage = { store:{}, getItem(k){return this.store[k]??null}, setItem(k,v){this.store[k]=String(v)} };
globalThis.location = {
  origin: "https://onchain-matrix.github.io",
  pathname: "/onmx-gamification/",
  search: "?ref=sample_syn_0103",
  href: "https://onchain-matrix.github.io/onmx-gamification/?ref=sample_syn_0103",
};
try { Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true }); } catch {}
console.log("BOOT_START");
${body}
await new Promise(r => setTimeout(r, 80));
const when = document.getElementById("seasonWhen").textContent;
const prize = document.getElementById("prizeCopy").innerHTML;
const out = document.getElementById("out").innerHTML;
const ref = document.getElementById("refSignup");
if (!when || when.length < 10) { console.error("FAIL seasonWhen", when); process.exit(2); }
if (!prize || !/BNB/.test(prize)) { console.error("FAIL prizeCopy", prize?.slice(0,80)); process.exit(3); }
if (!out || out.length < 100) { console.error("FAIL out", out?.length); process.exit(4); }
// Referral UI is gated off (PUBLIC_UI.showReferral=false): ?ref= must NOT open the signup form.
if (/Sign up/i.test(ref.innerHTML)) { console.error("FAIL ref form shown while referral gated off"); process.exit(5); }
if (!/hasn't launched yet/.test(out) || /sample|synthetic|provisional|preview/i.test(out)) { console.error("FAIL board empty state", out.slice(0,200)); process.exit(6); }
if (!/[$]600 paid in BNB/.test(prize) || /1 BNB|700/.test(prize)) { console.error("FAIL prize copy", prize); process.exit(7); }
if (!/Starts /.test(when)) { console.error("FAIL seasonWhen upcoming", when); process.exit(8); }
const claims = document.getElementById("claimsApiPanel");
if (claims.hidden === false && /decoder_implemented|preview only/.test(claims.innerHTML)) { console.error("FAIL claims panel dev strings"); process.exit(9); }
console.log("BOOT_OK");
`;
  writeFileSync(bootPath, harness);
  const r = spawnSync(process.execPath, [bootPath], { encoding: "utf8", cwd: root, timeout: 15000 });
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`harness exit ${r.status}: ${(r.stdout || "") + (r.stderr || "")}`.slice(0, 800));
  ok(/BOOT_OK/.test(r.stdout), "BOOT_OK missing");
});

// Named-export check (async import)
{
  const name = "every named import from index exists as export on target module";
  try {
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const { named, namespaces } = extractImportExpectations(script);
    ok(named.length >= 8, "expected named config imports, got " + named.length);
    ok(namespaces.some(n => n.mod.includes("engine")), "engine namespace");
    ok(namespaces.some(n => n.mod.includes("referral")), "referral namespace");
    for (const { mod, id } of named) {
      const ns = await import(pathToFileURL(join(root, mod)).href);
      ok(id in ns, `missing export ${id} from ${mod}`);
    }
    for (const { mod } of namespaces) {
      const ns = await import(pathToFileURL(join(root, mod)).href);
      ok(Object.keys(ns).length > 0, `namespace module empty: ${mod}`);
    }
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, error: e.message });
  }
}

const summary = {
  total: results.length,
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  suite: "bootstrap-runtime",
};
console.log(JSON.stringify(summary));
for (const r of results) if (!r.pass) console.log("FAIL", r.name, r.error);
writeFileSync(new URL("./bootstrap-runtime-results.json", import.meta.url), JSON.stringify({ summary, results }, null, 1));
process.exit(summary.failed ? 1 : 0);
