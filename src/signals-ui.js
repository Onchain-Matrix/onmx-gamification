/**
 * Matrix Signals + server-side referral UI (client). Rendered only when PUBLIC_UI.signals / PUBLIC_UI.referral are true,
 * or in owner preview (?preview=signals + admin token verified against the Worker, kept in this tab only).
 * Credits come only from reviewer approval in the Worker; this client never computes or stores awards.
 */
const PLAYER_KEY = "onmx_player_v1";
const PREVIEW_KEY = "onmx_admin_preview";
const REF_KEY = "onmx_pending_ref";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPE_LABEL = { reply: "Reply", quote: "Quote post", connect: "Connect", discover: "Discover", standalone: "Standalone post" };
const TOPIC_LABEL = { rwa: "RWA / tokenization", bnb: "BNB Chain", treasury: "Treasury", defi: "DeFi / yield", stablecoin: "Stablecoins", credit: "Lending / credit", macro: "Macro / liquidity", tokenomics: "Protocol economics", data: "Onchain data", other: "Other" };
const ERR = {
  invalid_handle: "Enter a valid X handle (1–15 letters, numbers or _).",
  handle_taken: "That handle is already registered. If it is yours, contact the team.",
  self_referral: "You can't use your own referral link.",
  invalid_type: "Pick a signal type.",
  invalid_topic: "Pick a topic.",
  invalid_why: "Say in 10–280 characters why Onchain Matrix was relevant.",
  invalid_signal_url: "Signal link must be an x.com post link (x.com/you/status/…).",
  signal_not_by_player: "The signal link must be a post from your registered handle.",
  target_required: "Add the link to the post you replied to or quoted.",
  invalid_target_url: "Target must be an x.com post link (Discover can also use a profile link).",
  signal_equals_target: "Signal and target can't be the same post.",
  target_is_self: "The target should be someone else's post.",
  duplicate_signal: "That signal was already submitted.",
  duplicate_target: "You already submitted a signal for that post. One per post.",
  daily_limit: "Daily limit reached (5 per day). Quality over volume — try again tomorrow.",
  pending_limit: "You have 10 signals waiting for review. Please wait for some to be reviewed.",
  player_unauthorized: "Player key not recognised.",
  signals_not_open: "Matrix Signals isn't open yet.",
  rate_limited: "Too many attempts. Try again later.",
};
const errText = (j, st) => ERR[j && j.error] || `Something went wrong (${esc((j && j.error) || st)}).`;

const store = {
  get(k, s = localStorage) { try { return JSON.parse(s.getItem(k) || "null"); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, JSON.stringify(v)); } catch {} },
  del(k, s = localStorage) { try { s.removeItem(k); } catch {} },
};

export function previewRequested(search = location.search) {
  return new URLSearchParams(search).get("preview") === "signals";
}
export function readRefParam(search = location.search) {
  const r = String(new URLSearchParams(search).get("ref") || "").trim().toUpperCase();
  return /^[A-Z0-9]{8}$/.test(r) ? r : null;
}

function api(apiBase, adminPreview) {
  return async (path, { method = "GET", body, playerKey, bearer } = {}) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (playerKey) headers["X-Player-Key"] = playerKey;
    if (adminPreview) headers["X-Admin-Preview"] = adminPreview;
    if (bearer) headers.Authorization = "Bearer " + bearer;
    const res = await fetch(apiBase + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, ok: res.ok && json && json.ok, json };
  };
}

/** Verify an admin token for owner preview. Returns true when the Worker accepts it. */
export async function verifyPreviewToken(apiBase, token) {
  if (!token) return false;
  try { const r = await api(apiBase, null)("/v1/admin/ping", { bearer: token }); return !!r.ok; } catch { return false; }
}
export function savedPreviewToken() { return store.get(PREVIEW_KEY, sessionStorage); }
export function savePreviewToken(t) { store.set(PREVIEW_KEY, t, sessionStorage); }

/** Owner-preview gate form (only rendered with ?preview=signals). Resolves with a verified token or null. */
export function mountPreviewGate(root, apiBase, onOk) {
  root.hidden = false;
  root.innerHTML = `<h3>Owner preview</h3>
    <p class="note">Enter the admin token to preview Matrix Signals and referrals. It stays in this tab only and is never sent anywhere except the claims Worker.</p>
    <form class="s" id="pvForm" autocomplete="off"><input id="pvTok" type="password" placeholder="Admin token" aria-label="Admin token"><button class="btn" type="submit">Unlock</button></form>
    <div class="note" id="pvMsg" aria-live="polite"></div>`;
  root.querySelector("#pvForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const t = root.querySelector("#pvTok").value.trim();
    const msg = root.querySelector("#pvMsg");
    msg.textContent = "Checking…";
    if (await verifyPreviewToken(apiBase, t)) { savePreviewToken(t); root.hidden = true; root.innerHTML = ""; onOk(t); }
    else msg.textContent = "Token not accepted.";
  };
}

/** Credit table HTML for "How the game works" (values from SIGNALS config; marked proposed only in preview). */
export function creditTableHtml(SIGNALS, tasks, { preview = false } = {}) {
  const tiers = Object.entries(SIGNALS.tierMultiplier);
  const tierName = { accepted: "Accepted", strong: "Strong", outstanding: "Outstanding" };
  const rows = tasks.map((t) => {
    const type = t.id.replace(/^signal_/, "");
    const b = SIGNALS.baseCredits[type] || 0;
    return `<tr><th scope="row">${esc(t.label)}</th>${tiers.map(([, m]) => `<td>${b * m}</td>`).join("")}</tr>`;
  }).join("");
  const ob = SIGNALS.outcomeBonus;
  return `<div class="sigtable-wrap"><table class="sigtable"><caption>${preview ? "Proposed " : ""}Credits per approved signal</caption>
    <thead><tr><th scope="col">Type</th>${tiers.map(([k]) => `<th scope="col">${tierName[k] || esc(k)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">Outcome bonus (confirmed by a reviewer): account you replied to answers +${ob.kolReplied}, follows @OnchainMatrix +${ob.kolFollowed}, someone asks about Onchain Matrix +${ob.directInterest}, leads to an introduction or partnership talk +${ob.introduction} (max +${SIGNALS.bonusCapPerSignal} per signal). Low-effort, copy-paste, off-topic or spammy signals earn 0.</p>`;
}

export function tasksListHtml(tasks) {
  return `<ul class="tasks">${tasks.map((t) => `<li><b>${esc(t.label)}</b> — ${esc(t.desc)}</li>`).join("")}</ul>`;
}

/**
 * Mount the player panel.
 * opts: { root, apiBase, SIGNALS, SEASON, showSignals, showReferral, adminPreview (token|null) }
 */
export async function mountSignalsPanel(opts) {
  const { root, apiBase, SIGNALS, SEASON, showSignals, showReferral, adminPreview } = opts;
  const call = api(apiBase, adminPreview || null);
  const preview = !!adminPreview;
  const urlRef = readRefParam();
  if (urlRef) store.set(REF_KEY, urlRef, sessionStorage);
  const pendingRef = urlRef || store.get(REF_KEY, sessionStorage);
  root.hidden = false;
  const banner = preview ? `<p class="warnproto">Owner preview — not live. Values are proposed until approved. Rows created here are marked preview and can be purged.</p>` : "";
  let player = store.get(PLAYER_KEY);

  async function renderJoin(note = "") {
    let refLine = "";
    if (pendingRef && showReferral) {
      const r = await call(`/v1/referral/resolve?code=${encodeURIComponent(pendingRef)}`).catch(() => null);
      refLine = r && r.json && r.json.valid ? `<p class="note">Invited by <b>${esc(r.json.referrer)}</b>. Your inviter earns Credits when your first signal is approved.</p>` : "";
    }
    root.innerHTML = `<h3>Matrix Signals</h3>${banner}
      <p class="note">Find an X conversation where Onchain Matrix genuinely belongs, add something useful, and mention <b>@OnchainMatrix</b> only when it fits. A reviewer approves each signal; quality beats volume.</p>
      ${refLine}
      <form class="s" id="sgJoin" autocomplete="off"><input id="sgHandle" maxlength="16" placeholder="@your_handle" aria-label="Your X handle"><button class="btn" type="submit">Join</button></form>
      <p class="note">No X login. Reviewers check that every signal you submit was posted from this handle.</p>
      <details class="note"><summary>Already joined on another device?</summary>
        <form class="s" id="sgKeyForm" autocomplete="off" style="margin-top:6px"><input id="sgKey" type="password" placeholder="Player key (onmxp_…)" aria-label="Player key"><button class="btn ghost" type="submit">Use key</button></form></details>
      <div class="note" id="sgMsg" aria-live="polite">${esc(note)}</div>`;
    root.querySelector("#sgJoin").onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = root.querySelector("#sgMsg");
      const handle = root.querySelector("#sgHandle").value.trim();
      if (!/^@?[A-Za-z0-9_]{1,15}$/.test(handle)) { msg.textContent = ERR.invalid_handle; return; }
      msg.textContent = "Joining…";
      const r = await call("/v1/signals/register", { method: "POST", body: { handle, ref: showReferral ? pendingRef || undefined : undefined } });
      if (!r.ok) { msg.textContent = errText(r.json, r.status); return; }
      player = { handle: r.json.handle, key: r.json.playerKey, refCode: r.json.refCode };
      store.set(PLAYER_KEY, player);
      store.del(REF_KEY, sessionStorage);
      await renderPlayer({ justJoined: true });
    };
    root.querySelector("#sgKeyForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const key = root.querySelector("#sgKey").value.trim();
      const r = await call("/v1/signals/me", { playerKey: key });
      if (!r.ok) { root.querySelector("#sgMsg").textContent = errText(r.json, r.status); return; }
      player = { handle: r.json.handle, key, refCode: r.json.refCode };
      store.set(PLAYER_KEY, player);
      await renderPlayer();
    };
  }

  async function renderPlayer({ justJoined = false } = {}) {
    const r = await call("/v1/signals/me", { playerKey: player.key });
    if (!r.ok) {
      if (r.status === 401) { store.del(PLAYER_KEY); player = null; return renderJoin("Saved player key no longer works — join again or use your key."); }
      root.innerHTML = `<h3>Matrix Signals</h3>${banner}<p class="note">${errText(r.json, r.status)}</p>`;
      return;
    }
    const me = r.json;
    const link = location.origin + location.pathname.replace(/index\.html$/, "") + "?ref=" + encodeURIComponent(me.refCode);
    const chip = (s) => s.status === "approved" ? `<span class="chip ok">Approved · +${s.credits}</span>` : s.status === "rejected" ? `<span class="chip no">Not approved</span>` : `<span class="chip">In review</span>`;
    const list = me.signals.length ? me.signals.slice(0, 10).map((s) => `<li>${chip(s)} <b>${esc(TYPE_LABEL[s.type] || s.type)}</b> · ${esc(TOPIC_LABEL[s.topic] || s.topic)}${s.signalUrl ? ` · <a href="${esc(s.signalUrl)}" target="_blank" rel="noopener nofollow">post</a>` : ""}${s.status === "rejected" && s.rejectReason ? `<div class="note">${esc(s.rejectReason)}</div>` : ""}</li>`).join("") : `<li class="note">No signals yet.</li>`;
    const sigHtml = showSignals ? `
      <div class="sgstats"><div><div class="big" style="font-size:26px">${me.credits.seasonSignal}</div><div class="unit">Season ${me.season} signal Credits</div></div>
        ${showReferral ? `<div><div class="big" style="font-size:26px">${me.credits.referralLifetime}</div><div class="unit">Referral Credits (lifetime)</div></div>` : ""}</div>
      <form id="sgForm" class="sgform" autocomplete="off">
        <div><label for="sgType">Signal type</label><select id="sgType" required>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></div>
        <div><label for="sgTopic">Topic</label><select id="sgTopic" required>${SIGNALS.topics.map((k) => `<option value="${k}">${esc(TOPIC_LABEL[k] || k)}</option>`).join("")}</select></div>
        <div class="full"><label for="sgUrl">Your post link</label><input id="sgUrl" type="url" inputmode="url" placeholder="https://x.com/${esc(me.handle.slice(1))}/status/…"></div>
        <div class="full"><label for="sgTarget">Post you replied to / quoted (Discover: account or post)</label><input id="sgTarget" type="url" inputmode="url" placeholder="https://x.com/…"></div>
        <div class="full"><label for="sgWhy">Why was Onchain Matrix relevant here?</label><textarea id="sgWhy" maxlength="280" rows="2" placeholder="One or two sentences"></textarea></div>
        <div class="full sgrow"><label class="inl"><input id="sgMention" type="checkbox"> I mentioned @OnchainMatrix</label><button class="btn" type="submit">Submit for review</button></div>
        <div class="full note" id="sgMsg" aria-live="polite"></div>
      </form>
      <p class="note">Up to ${SIGNALS.maxSubmissionsPerDay} per day, one per target post. Credits are added only after a reviewer approves your signal.</p>
      <h3 style="margin-top:10px">Your signals</h3><ul class="sglist">${list}</ul>` : "";
    const refHtml = showReferral ? `
      <div class="refbox"><div><b>Your referral link</b></div>
        <div class="rowline"><input readonly id="sgRefLink" value="${esc(link)}" aria-label="Your referral link"><button type="button" class="btn" id="sgRefCopy">Copy</button></div>
        <div class="note">Pending: <b>${me.referrals.pending}</b> · Qualified: <b>${me.referrals.qualified}</b>${me.referrals.overCap ? ` · over the season cap: <b>${me.referrals.overCap}</b>` : ""} · Referral Credits earned: <b>${me.referrals.l1Credits + me.referrals.l2Credits}</b></div>
        <p class="note">A referral qualifies when your friend's first signal is approved: you get +${SEASON.referral.referrerCredits} Credits, and +${SEASON.referral.level2Credits} when someone they invite qualifies. Up to ${SEASON.referral.capQualifiedPerSeason} qualified referrals per season. Referral Credits count toward lifetime Credits, not the Season ${me.season} prize ranking.</p>
        ${me.referredBy ? `<p class="note">You joined via ${esc(me.referredBy.handle)} (${me.referredBy.status === "qualified" ? "qualified" : "qualifies when your first signal is approved"}).</p>` : ""}</div>` : "";
    const keyHtml = justJoined ? `<div class="refbox"><b>Your player key</b><div class="rowline"><input readonly id="sgKeyShow" value="${esc(player.key)}" aria-label="Your player key"><button type="button" class="btn ghost" id="sgKeyCopy">Copy</button></div>
      <p class="warnproto">Saved in this browser. Keep a copy to use another device — anyone with this key can submit as you. It is shown only once.</p></div>` : "";
    root.innerHTML = `<h3>Matrix Signals · ${esc(me.handle)}</h3>${banner}${keyHtml}${sigHtml}${refHtml}
      <p class="note"><button type="button" class="linkbtn" id="sgOut">Sign out of this browser</button></p>`;
    const copy = (btnId, inpId) => { const b = root.querySelector(btnId); if (b) b.onclick = async () => { const i = root.querySelector(inpId); try { await navigator.clipboard.writeText(i.value); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } catch { i.select(); } }; };
    copy("#sgRefCopy", "#sgRefLink");
    copy("#sgKeyCopy", "#sgKeyShow");
    root.querySelector("#sgOut").onclick = () => { store.del(PLAYER_KEY); player = null; renderJoin(); };
    const form = root.querySelector("#sgForm");
    if (form) form.onsubmit = async (ev) => {
      ev.preventDefault();
      const msg = root.querySelector("#sgMsg");
      msg.textContent = "Submitting…";
      const body = {
        type: form.querySelector("#sgType").value, topic: form.querySelector("#sgTopic").value,
        signalUrl: form.querySelector("#sgUrl").value.trim(), targetUrl: form.querySelector("#sgTarget").value.trim(),
        why: form.querySelector("#sgWhy").value.trim(), onmxMentioned: form.querySelector("#sgMention").checked,
      };
      const res = await call("/v1/signals", { method: "POST", body, playerKey: player.key });
      if (!res.ok) { msg.textContent = errText(res.json, res.status); return; }
      await renderPlayer();
      const m2 = root.querySelector("#sgMsg"); if (m2) m2.textContent = "Submitted — a reviewer will check it.";
    };
  }

  if (player && player.key) await renderPlayer(); else await renderJoin();
}

/** Season leaderboard from the Worker (approved Signal Credits only). Returns the JSON body or throws. */
export async function fetchLeaderboard(apiBase, { adminPreview = null, limit = 20, handle = "" } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (handle) q.set("handle", handle);
  const r = await api(apiBase, adminPreview)(`/v1/leaderboard?${q}`);
  if (!r.ok) throw new Error("leaderboard " + r.status);
  return r.json;
}
