/** Minimal JSON-RPC helpers for public endpoints. */
export async function rpcCall(rpcUrl, method, params, fetchImpl = fetch) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw Object.assign(new Error("rpc_http_" + res.status), { status: 502 });
  const j = await res.json();
  if (j.error) throw Object.assign(new Error("rpc_error_" + (j.error.message || j.error.code)), { status: 502 });
  return j.result;
}

export async function getReceipt(rpcUrl, txHash, fetchImpl) {
  return rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash], fetchImpl);
}

export async function getBlockNumber(rpcUrl, fetchImpl) {
  const hex = await rpcCall(rpcUrl, "eth_blockNumber", [], fetchImpl);
  return parseInt(hex, 16);
}

export function pickRpc(env, chainId) {
  if (chainId === 56) return env.BNB_RPC_URL || "https://bsc-dataseed.binance.org/";
  if (chainId === 1) return env.ETH_RPC_URL || "https://ethereum.publicnode.com";
  return null;
}
