-- AI reply-quality review, shadow mode only.
-- Writes score rows and optional fetched post text. Never changes signal status or credits.

ALTER TABLE signals ADD COLUMN reply_text TEXT;
ALTER TABLE signals ADD COLUMN target_text TEXT;
ALTER TABLE signals ADD COLUMN fetched_at TEXT;

CREATE TABLE IF NOT EXISTS signal_scores (
  signal_id TEXT PRIMARY KEY NOT NULL REFERENCES signals(id),
  status TEXT NOT NULL,                  -- scored | no_x_secret | fetch_failed | no_text | prescreen_reject | parse_failed | ai_failed
  prescreen_version TEXT,
  prescreen_verdict TEXT,                -- pass | reject
  reject_reason TEXT,
  cluster_id TEXT,
  cluster_size INTEGER,
  auto_approve_blocked INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  prompt_version TEXT,
  substance INTEGER,
  confidence REAL,
  suggested_tier TEXT,
  reasons_json TEXT,
  flags_json TEXT,
  would_auto_approve INTEGER NOT NULL DEFAULT 0,
  scored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_would ON signal_scores(would_auto_approve, scored_at);
CREATE INDEX IF NOT EXISTS idx_scores_status ON signal_scores(status);
