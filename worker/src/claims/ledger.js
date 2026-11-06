/**
 * Atomic purchase claim ledger writes.
 * Never trusts client points/USD/season/identity — caller supplies server-verified fields only.
 */
import { POLICY, treasuryBuyPoints, classifyPurchaseTime } from "./policy.js";
import { randomNonce } from "../lib/crypto.js";

function isUniqueViolation(e) {
  return /UNIQUE|unique|constraint/i.test(String(e && (e.message || e)));
}

/**
 * Insert an immutable claim snapshot with DB-enforced:
 * - UNIQUE(chain_id, tx_hash, log_index) receipt uniqueness
 * - UNIQUE(identity_id, award_season) WHERE award_season NOT NULL (one award slot per season)
 * - SUM(points_raw) for (identity, award_season) never exceeds POLICY.capPoints
 *
 * Race-safe: try first_in_season insert; on unique conflict retry as next_season_queue.
 */
export async function insertVerifiedClaim(db, {
  identityId,
  chainId,
  txHash,
  logIndex,
  purchaseUsd,
  purchaseAtMs,
  receiptStatus = "verified",
}) {
  if (!identityId || typeof identityId !== "string") {
    return { ok: false, error: "invalid_identity", status: 400 };
  }
  const usd = Number(purchaseUsd);
  if (!Number.isFinite(usd) || usd <= 0) {
    return { ok: false, error: "invalid_purchase_usd", status: 400 };
  }
  const hash = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    return { ok: false, error: "invalid_tx_hash", status: 400 };
  }
  const log = Number(logIndex ?? 0);
  if (!Number.isInteger(log) || log < 0) {
    return { ok: false, error: "invalid_log_index", status: 400 };
  }
  const chain = Number(chainId);
  if (![1, 56].includes(chain)) {
    return { ok: false, error: "unsupported_chain", status: 400 };
  }

  const points = treasuryBuyPoints(usd); // server formula only
  const classification = classifyPurchaseTime(purchaseAtMs ?? Date.now());
  const createdAt = new Date().toISOString();

  if (classification.status === "unassigned") {
    const id = "pc_" + randomNonce().slice(0, 24);
    try {
      await db
        .prepare(
          `INSERT INTO purchase_claims (
             id, identity_id, chain_id, tx_hash, log_index, receipt_status, purchase_usd,
             purchase_season, award_season, queue_reason, formula_version, policy_version,
             points_raw, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0, ?)`
        )
        .bind(
          id,
          identityId,
          chain,
          hash,
          log,
          receiptStatus,
          usd,
          classification.queueReason,
          POLICY.formulaVersion,
          POLICY.version,
          createdAt
        )
        .run();
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, error: "duplicate_receipt", status: 409 };
      throw e;
    }
    return {
      ok: true,
      claim: {
        id,
        purchaseUsd: usd,
        pointsRaw: 0,
        formulaVersion: POLICY.formulaVersion,
        purchaseSeason: null,
        awardSeason: null,
        queueReason: classification.queueReason,
        receiptStatus,
      },
    };
  }

  // Attempt first_in_season for current season award slot
  const attempts = [
    {
      purchaseSeason: classification.purchaseSeason,
      awardSeason: POLICY.seasonNumber,
      queueReason: "first_in_season",
    },
    {
      purchaseSeason: classification.purchaseSeason,
      awardSeason: POLICY.nextSeasonNumber,
      queueReason: "next_season_queue",
    },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    const id = "pc_" + randomNonce().slice(0, 24);
    const pointsRaw = points;

    // Cap check inside same logical write path: reject if existing sum + points > cap
    // With unique(identity, award_season) there should be at most one row; still enforce SUM.
    try {
      const sumRow = await db
        .prepare(
          `SELECT COALESCE(SUM(points_raw), 0) AS s FROM purchase_claims
           WHERE identity_id = ? AND award_season = ?`
        )
        .bind(identityId, attempt.awardSeason)
        .first();
      const existingSum = Number(sumRow?.s || 0);
      if (existingSum + pointsRaw > POLICY.capPoints + 1e-9) {
        // Slot taken or would exceed — try next attempt / fail
        lastErr = { ok: false, error: "season_cap_exceeded", status: 409 };
        continue;
      }

      await db
        .prepare(
          `INSERT INTO purchase_claims (
             id, identity_id, chain_id, tx_hash, log_index, receipt_status, purchase_usd,
             purchase_season, award_season, queue_reason, formula_version, policy_version,
             points_raw, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          identityId,
          chain,
          hash,
          log,
          receiptStatus,
          usd,
          attempt.purchaseSeason,
          attempt.awardSeason,
          attempt.queueReason,
          POLICY.formulaVersion,
          POLICY.version,
          pointsRaw,
          createdAt
        )
        .run();

      // Post-insert cap assert (defense in depth if race slipped)
      const after = await db
        .prepare(
          `SELECT COALESCE(SUM(points_raw), 0) AS s FROM purchase_claims
           WHERE identity_id = ? AND award_season = ?`
        )
        .bind(identityId, attempt.awardSeason)
        .first();
      if (Number(after?.s || 0) > POLICY.capPoints + 1e-9) {
        await db.prepare(`DELETE FROM purchase_claims WHERE id = ?`).bind(id).run();
        lastErr = { ok: false, error: "season_cap_race", status: 409 };
        continue;
      }

      return {
        ok: true,
        claim: {
          id,
          purchaseUsd: usd,
          pointsRaw,
          formulaVersion: POLICY.formulaVersion,
          purchaseSeason: attempt.purchaseSeason,
          awardSeason: attempt.awardSeason,
          queueReason: attempt.queueReason,
          receiptStatus,
        },
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Duplicate receipt vs award-season slot collision
        const msg = String(e.message || e);
        if (/tx_hash|purchase_claims/i.test(msg) && /chain_id|tx_hash|log_index/i.test(msg)) {
          return { ok: false, error: "duplicate_receipt", status: 409 };
        }
        // unique identity+award_season → try next season queue
        lastErr = { ok: false, error: "award_season_taken", status: 409 };
        continue;
      }
      throw e;
    }
  }

  return lastErr || { ok: false, error: "claim_rejected", status: 409 };
}
