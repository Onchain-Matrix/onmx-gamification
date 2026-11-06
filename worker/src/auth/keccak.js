import { keccak_256 as k256 } from "@noble/hashes/sha3.js";
export function keccak_256(input) {
  return k256(input instanceof Uint8Array ? input : new Uint8Array(input));
}
