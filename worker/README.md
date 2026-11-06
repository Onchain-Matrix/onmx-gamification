# onmx-gamification-claims (Cloudflare Worker + D1)

Private durable ledger API for optional seed-claim identity bridge.

- **URL:** `https://onmx-gamification-claims.onmx.workers.dev`
- **Account:** Cloudflare account bound to Onchain Matrix (workers.dev subdomain `onmx`)
- **D1:** `onmx-gamification-claims`
- Ordinary play does **not** require a wallet.
- X login / production grants / receipt credits stay **fail-closed** until product X OAuth secrets, verified seed ABI/events, and RPC are configured.
- Do **not** reuse Grok Bot X connector tokens.

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Liveness |
| GET | `/v1/config` | Public policy + readiness/blockers (no secrets) |
| POST | `/v1/auth/x/start` | 503 until X_CLIENT_* secrets exist |
| POST | `/v1/auth/wallet/challenge` | SIWE challenge (CORS: Pages origin) |
| POST | `/v1/auth/wallet/verify` | EIP-191 verify; HttpOnly session cookie |
| GET | `/v1/me` | Authenticated identity |
| GET | `/v1/claims` | Authenticated claims list |
| POST | `/v1/claims/receipt` | Fail-closed without ABI; fixtures only when `ALLOW_TEST_FIXTURE_RECEIPTS=1` (never in production) |

## Tests

```bash
npm test
```

Uses Vitest + `@cloudflare/vitest-pool-workers` (Miniflare/workerd), not a real browser.
