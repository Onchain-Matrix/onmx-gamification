/**
 * SIWE / EIP-4361 challenge + EIP-191 personal_sign verify (EOA).
 * EIP-1271 requires RPC — fail-closed unless RPC + bytecode check configured.
 * A wallet signature does NOT prove X ownership or single-human uniqueness.
 */
import { randomNonce, sha256Hex } from "../lib/crypto.js";

const EIP191_PREFIX = "\x19Ethereum Signed Message:\n";

export function normalizeAddress(addr) {
  const a = String(addr || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  return a;
}

export function buildSiweMessage({
  domain,
  address,
  statement,
  uri,
  version = "1",
  chainId,
  nonce,
  issuedAt,
  expirationTime,
}) {
  const addr = normalizeAddress(address);
  if (!addr) throw Object.assign(new Error("invalid_address"), { status: 400 });
  // EIP-4361 uses checksummed address in message; we accept lowercase construction
  // and recover against normalized lowercase for comparison.
  const lines = [
    `${domain} wants you to sign in with your Ethereum account:`,
    addr,
    "",
    statement || "Sign in to ONMX Contributor Credits (provisional). Wallet link is optional seed-claim bridge only.",
    "",
    `URI: ${uri}`,
    `Version: ${version}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ];
  return lines.join("\n");
}

function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error("bad_hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b) {
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function keccak256(bytes) {
  // Workers: use subtle if available via nodejs_compat keccak — fallback noble-free impl via crypto.subtle is SHA only.
  // Use built-in keccak from node:crypto when nodejs_compat is on.
  const { keccak_256 } = await import("./keccak.js");
  return keccak_256(bytes);
}

export async function hashPersonalMessage(message) {
  const msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const prefix = new TextEncoder().encode(EIP191_PREFIX + String(msg.length));
  const joined = new Uint8Array(prefix.length + msg.length);
  joined.set(prefix, 0);
  joined.set(msg, prefix.length);
  return keccak256(joined);
}

/** Recover address from EIP-191 signature. Returns lowercase 0x… or null. */
export async function recoverPersonalSignature(message, signature) {
  const sig = String(signature || "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return null;
  const raw = hexToBytes(sig);
  let v = raw[64];
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) return null;
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const msgHash = await hashPersonalMessage(message);
  const { recoverAddress } = await import("./secp256k1.js");
  try {
    return await recoverAddress(msgHash, r, s, v - 27);
  } catch {
    return null;
  }
}

export async function verifySiwe({
  message,
  signature,
  expectedDomain,
  expectedUri,
  expectedAddress,
  expectedNonce,
  expectedChainId,
  nowMs = Date.now(),
}) {
  const fields = parseSiwe(message);
  if (!fields) return { ok: false, error: "siwe_parse" };
  if (fields.domain !== expectedDomain) return { ok: false, error: "siwe_domain" };
  if (fields.uri !== expectedUri) return { ok: false, error: "siwe_uri" };
  if (Number(fields.chainId) !== Number(expectedChainId)) return { ok: false, error: "siwe_chain" };
  if (fields.nonce !== expectedNonce) return { ok: false, error: "siwe_nonce" };
  const addr = normalizeAddress(fields.address);
  const expect = normalizeAddress(expectedAddress);
  if (!addr || !expect || addr !== expect) return { ok: false, error: "siwe_address" };
  const exp = Date.parse(fields.expirationTime);
  const iat = Date.parse(fields.issuedAt);
  if (Number.isNaN(exp) || Number.isNaN(iat)) return { ok: false, error: "siwe_time" };
  if (nowMs > exp) return { ok: false, error: "siwe_expired" };
  if (nowMs + 120_000 < iat) return { ok: false, error: "siwe_issued_future" };

  const recovered = await recoverPersonalSignature(message, signature);
  if (!recovered || recovered !== expect) {
    // EIP-1271 path requires RPC — fail closed here with distinct error
    return { ok: false, error: "siwe_bad_signature", eip1271: "unavailable_without_rpc" };
  }
  return { ok: true, address: expect, chainId: Number(fields.chainId), fields };
}

export function parseSiwe(message) {
  const lines = String(message || "").split("\n");
  if (lines.length < 10) return null;
  const m0 = /^(.+) wants you to sign in with your Ethereum account:$/.exec(lines[0]);
  if (!m0) return null;
  const address = lines[1];
  const map = {};
  for (const line of lines.slice(2)) {
    const idx = line.indexOf(": ");
    if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 2);
  }
  if (!map.URI || !map.Version || !map["Chain ID"] || !map.Nonce || !map["Issued At"] || !map["Expiration Time"]) {
    return null;
  }
  return {
    domain: m0[1],
    address,
    uri: map.URI,
    version: map.Version,
    chainId: map["Chain ID"],
    nonce: map.Nonce,
    issuedAt: map["Issued At"],
    expirationTime: map["Expiration Time"],
    statement: lines.slice(3).find((l) => l && !l.includes(": ")) || "",
  };
}

export function newChallengeTimes(now = new Date(), ttlMs = 10 * 60 * 1000) {
  const issuedAt = now.toISOString();
  const expirationTime = new Date(now.getTime() + ttlMs).toISOString();
  return { issuedAt, expirationTime, nonce: randomNonce() };
}

export { sha256Hex };
