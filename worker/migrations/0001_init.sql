-- ONMX gamification claims ledger (private). Provisional policy.
PRAGMA foreign_keys = ON;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  -- optional, only when server-proven (never inferred)
  verified_email TEXT,
  verified_email_at TEXT
);

-- Stable X user id (numeric string). Unique when present. Mutable handle is NOT identity.
CREATE TABLE x_links (
  identity_id TEXT NOT NULL UNIQUE REFERENCES identities(id),
  x_user_id TEXT NOT NULL UNIQUE,
  x_username TEXT,
  linked_at TEXT NOT NULL
);

CREATE TABLE wallet_links (
  identity_id TEXT NOT NULL REFERENCES identities(id),
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL, -- lowercase 0x…
  linked_at TEXT NOT NULL,
  UNIQUE (chain_id, address),
  UNIQUE (identity_id, chain_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_hash TEXT
);

CREATE TABLE auth_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL, -- siwe | oauth_state
  identity_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- Immutable purchase/claim snapshots. Client-supplied points NEVER trusted.
CREATE TABLE purchase_claims (
  id TEXT PRIMARY KEY NOT NULL,
  identity_id TEXT NOT NULL REFERENCES identities(id),
  -- chain+tx(+log) uniqueness for verified receipts
  chain_id INTEGER,
  tx_hash TEXT,
  log_index INTEGER,
  receipt_status TEXT NOT NULL, -- unverified | verified | rejected | unavailable
  purchase_usd REAL,
  -- seasons: source vs award (queued next-season keeps both)
  purchase_season INTEGER, -- NULL = UNASSIGNED (e.g. pre-launch)
  award_season INTEGER,    -- NULL = unawarded / waiting policy
  queue_reason TEXT,      -- first_in_season | next_season_queue | unassigned_prelaunch | …
  formula_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  points_raw REAL NOT NULL, -- snapshot locked at insert
  created_at TEXT NOT NULL,
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX idx_claims_identity ON purchase_claims(identity_id);
CREATE INDEX idx_claims_award_season ON purchase_claims(award_season);
CREATE INDEX idx_sessions_identity ON sessions(identity_id);
CREATE INDEX idx_nonces_expires ON auth_nonces(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
