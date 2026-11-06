// Seeded synthetic data. ALL accounts/tasks/referrals are FAKE. Not real ONMX members.
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const TYPES = ["receipt_check", "verifier_checklist", "architect_ship", "circle_onboard", "video_watch"];
export function addDays(iso, d) { return new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10); }
export function makeAccounts(n, seed) {
  const r = rng(seed); const bands = [0, 0, 0, 0, 10, 50, 1000, 10000, 100000];
  return Array.from({ length: n }, (_, i) => ({ handle: "sample_syn_" + String(i + 1).padStart(4, "0"), account: "@sample_syn_" + String(i + 1).padStart(4, "0"),
    synthetic: true, seedUsd: bands[Math.floor(r() * bands.length)], activity: r(), verifierDate: addDays("2026-10-01", Math.floor(r() * 30)) }));
}
export function makeTasks(accounts, start, days, seed) {
  const r = rng(seed); const tasks = [];
  for (let d = 0; d < days; d++) for (const a of accounts) if (r() < a.activity * 0.5)
    tasks.push({ account: a.account, type: TYPES[Math.floor(r() * TYPES.length)], effort: 1 + Math.floor(r() * 3), date: addDays(start, d) });
  return tasks;
}
