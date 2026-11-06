/**
 * Optional Seed-claim client for the static dashboard.
 * Bearer + CSRF live in JS memory only (never URL / localStorage / sessionStorage).
 * Ordinary play does not require this module.
 */
export const CLAIMS_API_BASE = "https://onmx-gamification-claims.onmx.workers.dev";
export const WORKER_ORIGIN = "https://onmx-gamification-claims.onmx.workers.dev";
export const ALLOWED_OPENER_ORIGIN = "https://onchain-matrix.github.io";
export const OAUTH_MSG_TYPE = "onmx-oauth";

/** @typedef {{ accessToken: string, csrf: string, identityId?: string, expectedOAuthState?: string|null }} ClaimsSession */

/** In-memory session — intentionally NOT persisted. */
let session = /** @type {ClaimsSession|null} */ (null);
/** Pending OAuth state from /v1/auth/x/start (memory only; Worker postMessage may omit state). */
let pendingOAuthState = null;

export function getSession() {
  return session ? { ...session } : null;
}

export function setSession(next) {
  if (!next || !next.accessToken || !next.csrf) {
    session = null;
    return null;
  }
  session = {
    accessToken: String(next.accessToken),
    csrf: String(next.csrf),
    identityId: next.identityId ? String(next.identityId) : undefined,
    expectedOAuthState: next.expectedOAuthState ?? session?.expectedOAuthState ?? null,
  };
  return getSession();
}

export function clearSession() {
  session = null;
  pendingOAuthState = null;
}

export function getPendingOAuthState() {
  return pendingOAuthState;
}

/** Reject any attempt to persist credentials into Web Storage. */
export function assertNoCredentialStorage(storageLike) {
  if (!storageLike) return true;
  for (const k of Object.keys(storageLike.store || storageLike)) {
    const v = String((storageLike.getItem && storageLike.getItem(k)) || storageLike[k] || "");
    if (/accessToken|bearer|csrf|handoffCode|code_verifier/i.test(k) || /accessToken|Bearer\s/i.test(v)) {
      throw new Error("credential_storage_forbidden:" + k);
    }
  }
  return true;
}

export function authHeaders(extra = {}) {
  const s = session;
  const h = { Accept: "application/json", ...extra };
  if (s?.accessToken) h.Authorization = `Bearer ${s.accessToken}`;
  if (s?.csrf) h["X-CSRF-Token"] = s.csrf;
  return h;
}

export async function apiFetch(path, { method = "GET", body, fetchImpl = fetch, origin } = {}) {
  const headers = authHeaders({ "Content-Type": "application/json" });
  if (origin) headers.Origin = origin; // tests only; browsers set Origin themselves
  const res = await fetchImpl(`${CLAIMS_API_BASE}${path}`, {
    method,
    headers,
    credentials: "omit",
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

export async function fetchPublicConfig(fetchImpl = fetch) {
  const r = await apiFetch("/v1/config", { fetchImpl });
  return r;
}

/**
 * Validate OAuth popup postMessage before exchanging handoff.
 * Requires: exact Worker origin, exact popup window source, type, and optional state bind.
 */
export function validateOAuthPostMessage(event, { expectedSource, expectedState = null } = {}) {
  if (!event || typeof event !== "object") return { ok: false, error: "no_event" };
  if (event.origin !== WORKER_ORIGIN) return { ok: false, error: "wrong_origin" };
  if (expectedSource && event.source !== expectedSource) return { ok: false, error: "wrong_source" };
  const data = event.data;
  if (!data || data.type !== OAUTH_MSG_TYPE) return { ok: false, error: "wrong_type" };
  if (expectedState != null && data.state != null && data.state !== expectedState) {
    return { ok: false, error: "state_mismatch" };
  }
  if (data.ok === false) return { ok: false, error: data.error || "oauth_error" };
  if (!data.handoffCode || typeof data.handoffCode !== "string") {
    return { ok: false, error: "missing_handoff" };
  }
  // Never accept raw bearer in postMessage
  if (data.accessToken || data.csrf || data.code_verifier) {
    return { ok: false, error: "credential_in_postmessage" };
  }
  return { ok: true, handoffCode: data.handoffCode, state: data.state || null };
}

export async function startXLogin({ fetchImpl = fetch, openPopup = defaultOpenPopup, openerOrigin = ALLOWED_OPENER_ORIGIN } = {}) {
  const cfg = await fetchPublicConfig(fetchImpl);
  const ready = cfg.json?.readiness?.xLoginEnabled || cfg.json?.x?.ready;
  if (!cfg.ok || !ready) {
    return {
      ok: false,
      error: "x_oauth_not_configured",
      reason: "X product app secrets are not configured on the claims API (X_CLIENT_ID / X_CLIENT_SECRET / X_REDIRECT_URI).",
      status: 503,
    };
  }
  const start = await apiFetch("/v1/auth/x/start", {
    method: "POST",
    body: { openerOrigin },
    fetchImpl,
    origin: openerOrigin,
  });
  if (!start.ok || !start.json?.ok || !start.json.authorizeUrl) {
    return {
      ok: false,
      error: start.json?.error || "x_start_failed",
      status: start.status,
      reason: start.json?.error || "Could not start X login.",
    };
  }
  const state = start.json.state;
  pendingOAuthState = state;

  const popup = openPopup(start.json.authorizeUrl);
  if (!popup) {
    return { ok: false, error: "popup_blocked", reason: "Popup was blocked. Allow popups for this site and try again." };
  }

  return waitForHandoffAndExchange({ popup, expectedState: state, fetchImpl, openerOrigin });
}

function defaultOpenPopup(url) {
  return window.open(url, "onmx_x_oauth", "popup=yes,width=520,height=720");
}

export function waitForHandoffAndExchange({ popup, expectedState, fetchImpl = fetch, openerOrigin = ALLOWED_OPENER_ORIGIN, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        window.removeEventListener("message", onMsg);
      } catch {}
      clearTimeout(timer);
      try {
        popup?.close?.();
      } catch {}
      resolve(result);
    };
    const onMsg = async (event) => {
      const v = validateOAuthPostMessage(event, { expectedSource: popup, expectedState });
      if (!v.ok) {
        // Ignore unrelated messages; only fail hard on wrong_origin/source from our popup attempt with our type
        if (event?.data?.type === OAUTH_MSG_TYPE && (v.error === "wrong_origin" || v.error === "wrong_source" || v.error === "state_mismatch" || v.error === "credential_in_postmessage")) {
          finish({ ok: false, error: v.error, reason: `OAuth message rejected (${v.error}).` });
        }
        return;
      }
      const ex = await apiFetch("/v1/auth/session/exchange", {
        method: "POST",
        body: { handoffCode: v.handoffCode, openerOrigin },
        fetchImpl,
        origin: openerOrigin,
      });
      if (!ex.ok || !ex.json?.ok || !ex.json.accessToken || !ex.json.csrf) {
        finish({ ok: false, error: ex.json?.error || "handoff_exchange_failed", status: ex.status });
        return;
      }
      setSession({
        accessToken: ex.json.accessToken,
        csrf: ex.json.csrf,
        identityId: ex.json.identityId,
      });
      pendingOAuthState = null;
      finish({ ok: true, identityId: ex.json.identityId });
    };
    const timer = setTimeout(() => finish({ ok: false, error: "oauth_timeout", reason: "X login timed out." }), timeoutMs);
    try {
      window.addEventListener("message", onMsg);
    } catch (e) {
      finish({ ok: false, error: "no_window", reason: String(e) });
    }
  });
}

export async function fetchMe(fetchImpl = fetch) {
  if (!session?.accessToken) return { ok: false, error: "unauthenticated", status: 401 };
  return apiFetch("/v1/me", { fetchImpl });
}

export async function fetchClaims(fetchImpl = fetch) {
  if (!session?.accessToken) return { ok: false, error: "unauthenticated", status: 401 };
  return apiFetch("/v1/claims", { fetchImpl });
}

/**
 * EIP-1193 wallet link: eth_requestAccounts + personal_sign of server SIWE message only.
 * Never sends a transaction / never spends funds.
 */
export async function linkWalletViaSiwe({
  ethereum,
  chainId,
  fetchImpl = fetch,
  openerOrigin = ALLOWED_OPENER_ORIGIN,
} = {}) {
  if (!session?.accessToken) return { ok: false, error: "unauthenticated", reason: "Sign in with X first." };
  if (!ethereum || typeof ethereum.request !== "function") {
    return { ok: false, error: "no_eip1193", reason: "No EIP-1193 wallet detected." };
  }
  const cid = Number(chainId);
  if (![1, 56].includes(cid)) return { ok: false, error: "unsupported_chain", reason: "Only BNB (56) or Ethereum (1)." };

  const accounts = await ethereum.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { ok: false, error: "no_account", reason: "Wallet returned no account." };

  const chal = await apiFetch("/v1/auth/wallet/challenge", {
    method: "POST",
    body: { address, chainId: cid },
    fetchImpl,
    origin: openerOrigin,
  });
  if (!chal.ok || !chal.json?.ok || !chal.json.message || !chal.json.nonce) {
    return { ok: false, error: chal.json?.error || "challenge_failed", status: chal.status, reason: "Could not get SIWE challenge." };
  }
  // Bind nonce from server into the exact message we sign
  if (!String(chal.json.message).includes(chal.json.nonce)) {
    return { ok: false, error: "nonce_unbound", reason: "Challenge message missing server nonce." };
  }

  const signature = await ethereum.request({
    method: "personal_sign",
    params: [chal.json.message, address],
  });

  const ver = await apiFetch("/v1/auth/wallet/verify", {
    method: "POST",
    body: {
      message: chal.json.message,
      signature,
      address,
      chainId: cid,
    },
    fetchImpl,
    origin: openerOrigin,
  });
  if (!ver.ok || !ver.json?.ok) {
    return { ok: false, error: ver.json?.error || "verify_failed", status: ver.status, reason: "Wallet signature rejected." };
  }
  // Prefer refreshed bearer from verify response
  if (ver.json.accessToken && ver.json.csrf) {
    setSession({
      accessToken: ver.json.accessToken,
      csrf: ver.json.csrf,
      identityId: ver.json.identityId || session.identityId,
    });
  }
  return { ok: true, address: ver.json.address, chainId: ver.json.chainId, identityId: ver.json.identityId };
}

/**
 * Submit receipt locator only. Never send USD/points/season/email from the client.
 * When grants are off, API returns verifiedPreview — surface honestly, do not invent awards.
 */
export async function submitReceiptClaim({
  chainId,
  txHash,
  logIndex = null,
  fetchImpl = fetch,
  openerOrigin = ALLOWED_OPENER_ORIGIN,
  productionGrantsEnabled = false,
} = {}) {
  if (!session?.accessToken) return { ok: false, error: "unauthenticated", reason: "Sign in with X first." };
  const cid = Number(chainId);
  const hash = String(txHash || "").trim().toLowerCase();
  if (![1, 56].includes(cid)) return { ok: false, error: "unsupported_chain" };
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, error: "invalid_tx_hash", reason: "Enter a 0x… transaction hash." };

  const body = { chainId: cid, txHash: hash };
  if (logIndex != null && logIndex !== "" && Number.isFinite(Number(logIndex))) {
    body.logIndex = Number(logIndex);
  }

  const r = await apiFetch("/v1/claims/receipt", {
    method: "POST",
    body,
    fetchImpl,
    origin: openerOrigin,
  });

  if (r.status === 503 && r.json?.error === "grants_disabled") {
    return {
      ok: false,
      error: "grants_disabled",
      previewOnly: true,
      verifiedPreview: r.json.verifiedPreview || null,
      note: r.json.note || "Verification preview only — production grants are OFF.",
      status: 503,
    };
  }
  if (!r.ok || !r.json?.ok) {
    return {
      ok: false,
      error: r.json?.error || "claim_failed",
      status: r.status,
      reason: r.json?.error || "Claim request failed.",
      verification: r.json?.verification,
    };
  }
  if (!productionGrantsEnabled) {
    // Defensive: never treat a claim as awarded when UI knows grants are off
    return {
      ok: false,
      error: "grants_disabled_client",
      previewOnly: true,
      claim: r.json.claim || null,
      note: "Production grants OFF — ignoring award payload.",
    };
  }
  return { ok: true, claim: r.json.claim };
}

export function formatClaimRow(c) {
  if (!c) return "";
  const pts = c.points_raw ?? c.pointsRaw;
  const award = c.award_season ?? c.awardSeason;
  const purchase = c.purchase_season ?? c.purchaseSeason;
  const queue = c.queue_reason ?? c.queueReason;
  const usd = c.purchase_usd ?? c.purchaseUsd;
  const status = c.receipt_status ?? c.receiptStatus;
  const parts = [
    `chain ${c.chain_id ?? c.chainId}`,
    `tx ${String(c.tx_hash ?? c.txHash ?? "").slice(0, 10)}…`,
    status ? `status ${status}` : null,
    usd != null ? `USD ${usd}` : null,
    pts != null ? `points ${pts} (server)` : null,
    award != null ? `award season ${award}` : "award unassigned",
    purchase != null ? `purchase season ${purchase}` : "purchase season unassigned",
    queue ? `queue ${queue}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function readinessSummary(cfgJson) {
  const r = cfgJson?.readiness || {};
  const receipts = cfgJson?.receipts || {};
  return {
    xLoginEnabled: Boolean(r.xLoginEnabled || cfgJson?.x?.ready),
    productionGrantsEnabled: Boolean(r.productionGrantsEnabled),
    receiptVerification: r.receiptVerification || receipts.verificationReadiness || "unknown",
    decoderAvailable: Boolean(receipts.available),
    blockers: cfgJson?.blockers || [],
    sessionSecrets: Boolean(r.sessionSecrets),
  };
}

/**
 * Mount minimal optional Seed-claim UI into #claimsApiPanel (or provided root).
 * Does not gate ordinary play. No wallet prompt on load.
 */
export async function mountClaimsPanel(root, {
  fetchImpl = fetch,
  ethereum = typeof globalThis !== "undefined" ? globalThis.ethereum : undefined,
  openPopup,
  openerOrigin = typeof location !== "undefined" ? location.origin : ALLOWED_OPENER_ORIGIN,
} = {}) {
  if (!root) return { ok: false, error: "no_root" };

  const statusEl = root.querySelector("#claimsApiStatus") || root;
  const ui = ensureUi(root);
  let lastCfg = null;

  const setMsg = (html, kind = "note") => {
    ui.msg.className = kind === "warn" ? "warnproto" : "note";
    ui.msg.innerHTML = html;
  };

  const refreshConfig = async () => {
    const cfg = await fetchPublicConfig(fetchImpl);
    lastCfg = cfg.json;
    const sum = readinessSummary(cfg.json || {});
    const blockers = (sum.blockers || []).map((b) => `<li>${esc(b)}</li>`).join("");
    statusEl.innerHTML = `<p class="note"><b>API</b> <code>${esc(CLAIMS_API_BASE)}</code> · policy <b>${esc(cfg.json?.policyVersion || "")}</b></p>
      <p class="note">X login: <b>${sum.xLoginEnabled ? "available" : "not configured"}</b> · receipt decoder: <b>${esc(String(sum.receiptVerification))}</b> · production grants: <b>${sum.productionGrantsEnabled ? "ON" : "OFF (preview only)"}</b> · ordinary play wallet: <b>not required</b></p>
      <p class="warnproto">Optional seed-claim bridge only. Verified ledger points stay separate from the sample main board. Bearer session stays in page memory — reload requires sign-in again.</p>
      ${blockers ? `<ul class="tasks">${blockers}</ul>` : ""}`;
    ui.btnX.disabled = !sum.xLoginEnabled;
    ui.btnX.title = sum.xLoginEnabled
      ? "Sign in with X (popup)"
      : "Disabled: X product app secrets not configured on the claims API (X_CLIENT_ID / X_CLIENT_SECRET / X_REDIRECT_URI).";
    ui.btnClaim.disabled = !sum.productionGrantsEnabled;
    ui.btnClaim.textContent = sum.productionGrantsEnabled ? "Submit seed receipt" : "Verify receipt (preview only — grants OFF)";
    ui.btnClaim.title = sum.productionGrantsEnabled
      ? "Submit chain + tx hash for server verification"
      : "Production grants are OFF — you can still preview verification; no award is written.";
    // Preview button always allowed when authenticated; label already honest
    ui.btnClaim.disabled = false;
    return sum;
  };

  const refreshAccount = async () => {
    if (!getSession()?.accessToken) {
      ui.account.hidden = true;
      ui.authActions.hidden = false;
      ui.claimBox.hidden = true;
      return;
    }
    const me = await fetchMe(fetchImpl);
    if (!me.ok || !me.json?.ok) {
      if (me.status === 401) {
        clearSession();
        setMsg("Session expired — sign in with X again.", "warn");
        ui.account.hidden = true;
        ui.authActions.hidden = false;
        ui.claimBox.hidden = true;
        return;
      }
      setMsg(`Could not load account (${esc(me.json?.error || me.status)}).`, "warn");
      return;
    }
    const x = me.json.x;
    const handle = x?.username ? `@${x.username}` : "(X linked — username pending)";
    const xId = x?.xUserId ? ` · stable X id ${esc(x.xUserId)}` : "";
    const wallets = (me.json.wallets || [])
      .map((w) => `chain ${w.chain_id}: <code>${esc(w.address)}</code>`)
      .join("<br>") || "<i>No wallet linked yet (optional).</i>";
    ui.account.hidden = false;
    ui.authActions.hidden = true;
    ui.claimBox.hidden = false;
    ui.account.innerHTML = `<p class="note"><b>Verified X</b> ${esc(handle)}${xId}</p>
      <p class="note"><b>Wallets</b><br>${wallets}</p>
      <p class="note">Typed handles are not trusted — only the server-linked X user id / username above.</p>`;

    const cl = await fetchClaims(fetchImpl);
    if (cl.ok && cl.json?.ok) {
      const rows = cl.json.claims || [];
      ui.claimsList.innerHTML = rows.length
        ? `<p class="note"><b>Verified ledger claims</b> (not the sample main board)</p><ul class="tasks">${rows
            .map((c) => `<li>${esc(formatClaimRow(c))}</li>`)
            .join("")}</ul>`
        : `<p class="note">No verified ledger claims for this account yet.</p>`;
    }
  };

  ui.btnX.onclick = async () => {
    setMsg("Starting X login…");
    const sum = readinessSummary(lastCfg || {});
    if (!sum.xLoginEnabled) {
      setMsg(ui.btnX.title || "X login not configured.", "warn");
      return;
    }
    const r = await startXLogin({ fetchImpl, openPopup, openerOrigin });
    if (!r.ok) {
      setMsg(`X login failed: ${esc(r.reason || r.error)}`, "warn");
      return;
    }
    setMsg("Signed in with X (session in memory).");
    await refreshAccount();
  };

  ui.btnLogout.onclick = () => {
    clearSession();
    setMsg("Signed out — memory cleared.");
    ui.account.hidden = true;
    ui.authActions.hidden = false;
    ui.claimBox.hidden = true;
    ui.claimsList.innerHTML = "";
  };

  ui.btnWallet.onclick = async () => {
    const cid = Number(ui.chain.value);
    setMsg("Requesting wallet signature (message only — no transaction)…");
    try {
      const r = await linkWalletViaSiwe({ ethereum, chainId: cid, fetchImpl, openerOrigin });
      if (!r.ok) {
        setMsg(`Wallet link failed: ${esc(r.reason || r.error)}`, "warn");
        return;
      }
      setMsg(`Wallet linked: <code>${esc(r.address)}</code> on chain ${esc(String(r.chainId))}.`);
      await refreshAccount();
    } catch (e) {
      setMsg(`Wallet rejected or unavailable (${esc(String(e && e.message || e))}).`, "warn");
    }
  };

  ui.btnClaim.onclick = async () => {
    const sum = readinessSummary(lastCfg || {});
    const r = await submitReceiptClaim({
      chainId: Number(ui.chain.value),
      txHash: ui.tx.value,
      logIndex: ui.logIndex.value === "" ? null : ui.logIndex.value,
      fetchImpl,
      openerOrigin,
      productionGrantsEnabled: sum.productionGrantsEnabled,
    });
    if (r.previewOnly || r.error === "grants_disabled") {
      const prev = r.verifiedPreview;
      setMsg(
        `<b>Preview only — grants OFF.</b> ${esc(r.note || "")}<br>${
          prev
            ? `Verified purchaser <code>${esc(prev.purchaser || "")}</code> · USD ${esc(String(prev.purchaseUsd))} · log ${esc(String(prev.logIndex))} (server). No award written.`
            : "No award written."
        }`,
        "warn"
      );
      return;
    }
    if (!r.ok) {
      setMsg(`Claim failed: ${esc(r.reason || r.error)}`, "warn");
      return;
    }
    setMsg(`Claim recorded on server ledger: ${esc(formatClaimRow(r.claim))}`);
    await refreshAccount();
  };

  await refreshConfig();
  await refreshAccount();
  return { ok: true, refreshConfig, refreshAccount, getSession, clearSession };
}

function ensureUi(root) {
  let box = root.querySelector("[data-claims-ui]");
  if (box) {
    return {
      msg: box.querySelector("[data-msg]"),
      btnX: box.querySelector("[data-x]"),
      btnLogout: box.querySelector("[data-logout]"),
      btnWallet: box.querySelector("[data-wallet]"),
      btnClaim: box.querySelector("[data-claim]"),
      authActions: box.querySelector("[data-auth-actions]"),
      account: box.querySelector("[data-account]"),
      claimBox: box.querySelector("[data-claim-box]"),
      claimsList: box.querySelector("[data-claims-list]"),
      chain: box.querySelector("[data-chain]"),
      tx: box.querySelector("[data-tx]"),
      logIndex: box.querySelector("[data-logindex]"),
    };
  }
  box = document.createElement("div");
  box.setAttribute("data-claims-ui", "1");
  box.innerHTML = `
    <div data-msg class="note"></div>
    <div data-auth-actions>
      <button type="button" data-x class="btn">Sign in with X</button>
    </div>
    <div data-account hidden></div>
    <div data-claim-box hidden>
      <p class="note">Optional wallet proof (SIWE message only — never a purchase/tx). Chains: BNB 56 or ETH 1.</p>
      <label class="note">Chain
        <select data-chain>
          <option value="56">BNB Chain (56)</option>
          <option value="1">Ethereum (1)</option>
        </select>
      </label>
      <button type="button" data-wallet class="btn">Connect wallet + sign SIWE</button>
      <p class="note">Seed receipt: chain + tx hash only. Server verifies amount/purchaser. Do not type USD, points, season, or email.</p>
      <label class="note">Tx hash <input data-tx type="text" spellcheck="false" placeholder="0x…" maxlength="66" style="width:min(100%,28rem)"></label>
      <label class="note">Log index (optional) <input data-logindex type="number" min="0" step="1" placeholder="auto" style="width:6rem"></label>
      <button type="button" data-claim class="btn">Verify receipt</button>
      <button type="button" data-logout class="btn">Log out</button>
      <div data-claims-list></div>
    </div>`;
  root.appendChild(box);
  return {
    msg: box.querySelector("[data-msg]"),
    btnX: box.querySelector("[data-x]"),
    btnLogout: box.querySelector("[data-logout]"),
    btnWallet: box.querySelector("[data-wallet]"),
    btnClaim: box.querySelector("[data-claim]"),
    authActions: box.querySelector("[data-auth-actions]"),
    account: box.querySelector("[data-account]"),
    claimBox: box.querySelector("[data-claim-box]"),
    claimsList: box.querySelector("[data-claims-list]"),
    chain: box.querySelector("[data-chain]"),
    tx: box.querySelector("[data-tx]"),
    logIndex: box.querySelector("[data-logindex]"),
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
