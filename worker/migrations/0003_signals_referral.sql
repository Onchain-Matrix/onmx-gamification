-- Matrix Signals submissions + server-side referral ledger (PROVISIONAL; owner sign-off pending).
-- Credits are only written by reviewer approval (never self-awarded by a player).

CREATE TABLE IF NOT EXISTS signal_players (
  id TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL UNIQUE,           -- canonical lowercase X handle without @ (claimed, reviewer checks signal authorship)
  ref_code TEXT NOT NULL UNIQUE,         -- referral code (?ref=CODE)
  token_hash TEXT NOT NULL UNIQUE,       -- sha256 of the player key (key shown once, never stored)
  referrer_id TEXT REFERENCES signal_players(id), -- immutable once set (set only at registration)
  referred_at TEXT,
  ip_hash TEXT,                          -- salted hash, reviewer fraud hint only
  preview INTEGER NOT NULL DEFAULT 0,    -- 1 = created while Signals were closed (admin preview / smoke test)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sp_referrer ON signal_players(referrer_id);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES signal_players(id),
  season INTEGER NOT NULL,
  signal_type TEXT NOT NULL,             -- reply | quote | connect | discover | standalone
  signal_url TEXT,                       -- canonical https://x.com/<handle>/status/<id> (optional for discover)
  signal_key TEXT UNIQUE,                -- status id, dedupe per signal URL across all players
  target_url TEXT,
  target_key TEXT,                       -- status id or profile:<handle>
  target_handle TEXT,
  topic TEXT NOT NULL,
  onmx_mentioned INTEGER NOT NULL DEFAULT 0,
  why TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  tier TEXT,                             -- accepted | strong | outstanding (approved only)
  outcomes_json TEXT,                    -- reviewer metrics + outcome flags
  base_credits REAL NOT NULL DEFAULT 0,
  bonus_credits REAL NOT NULL DEFAULT 0,
  reject_reason TEXT,
  reviewer_note TEXT,
  submitted_at TEXT NOT NULL,
  submitted_day TEXT NOT NULL,           -- YYYY-MM-DD UTC for daily limit
  reviewed_at TEXT,
  preview INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_signals_player_day ON signals(player_id, submitted_day);
CREATE INDEX IF NOT EXISTS idx_signals_target ON signals(target_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_player_target ON signals(player_id, target_key) WHERE target_key IS NOT NULL;

-- Labeled Credits ledger. One row per (kind, source, player). Server-written only.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES signal_players(id),
  season INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- signal | signal_bonus | referral_l1 | referral_l2
  credits REAL NOT NULL,
  label TEXT NOT NULL,
  source_id TEXT NOT NULL,               -- signal id or referred player id
  created_at TEXT NOT NULL,
  UNIQUE (kind, source_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ledger_player ON credit_ledger(player_id, season);

-- Referral qualification (one row per referred player; immutable referrer).
CREATE TABLE IF NOT EXISTS referrals (
  referred_id TEXT PRIMARY KEY NOT NULL REFERENCES signal_players(id),
  referrer_id TEXT NOT NULL REFERENCES signal_players(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | qualified | over_cap
  season INTEGER,                         -- season in which it qualified
  qualified_at TEXT,
  qualifying_signal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_id, status, season);
