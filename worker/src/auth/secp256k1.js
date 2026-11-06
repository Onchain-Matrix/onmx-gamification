import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "./keccak.js";

function toHex(b) {
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** recovery: 0|1; r,s: 32-byte Uint8Arrays; msgHash: 32 bytes */
export async function recoverAddress(msgHash, r, s, recovery) {
  const sig65 = new Uint8Array(65);
  sig65[0] = recovery;
  sig65.set(r, 1);
  sig65.set(s, 33);
  // noble v2: recoverPublicKey(signature, msgHash) → compressed pubkey
  const pubComp = secp256k1.recoverPublicKey(sig65, msgHash);
  const pub = secp256k1.Point.fromBytes(pubComp).toBytes(false).slice(1);
  return toHex(keccak_256(pub).slice(12));
}

export { secp256k1 };
