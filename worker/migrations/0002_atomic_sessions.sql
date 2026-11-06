-- Atomic season award uniqueness + bearer/handoff session support
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_claim_per_award_season
  ON purchase_claims(identity_id, award_season)
  WHERE award_season IS NOT NULL;

-- Cumulative cap helper index
CREATE INDEX IF NOT EXISTS idx_claims_identity_award_pts
  ON purchase_claims(identity_id, award_season, points_raw);

ALTER TABLE sessions ADD COLUMN bearer_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_bearer ON sessions(bearer_hash);

CREATE TABLE IF NOT EXISTS auth_handoffs (
  code TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  csrf TEXT NOT NULL,
  opener_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
