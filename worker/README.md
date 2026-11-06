# onmx-gamification-claims (Cloudflare Worker + D1)

Private durable ledger API for optional seed-claim identity bridge.

- **URL:** https://onmx-gamification-claims.onmx.workers.dev
- **D1:** `onmx-gamification-claims` (`15b34c40-9980-4d8b-833c-59f20ec02825`)
- Ordinary play does **not** require a wallet.
- Prefer **Bearer** sessions for Pages→workers.dev (cookies unreliable cross-site).
- X OAuth 2.0 PKCE implemented; fail-closed until `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REDIRECT_URI` Worker secrets exist.
- Receipt decoder implemented (dApp m0 ABI); ETH+BNB mined fixtures cross-checked. **Production grants OFF**.
- USD from `SeedPurchaseCompleted.paymentAmount` + USDT decimals/transfer — never calldata `tokenAmount` (ONMX qty).

## Product X OAuth config needed (parent/owner)

| Secret | Purpose |
|--------|---------|
| `X_CLIENT_ID` | X developer app client id |
| `X_CLIENT_SECRET` | X developer app client secret |
| `X_REDIRECT_URI` | Must be `https://onmx-gamification-claims.onmx.workers.dev/v1/auth/x/callback` |

Do **not** reuse Grok Bot X connector tokens.

## Tests

```bash
npm test
```
