CREATE TABLE IF NOT EXISTS ev_monthly_usage (
  user_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  ev_kwh REAL NOT NULL DEFAULT 0,
  non_ev_kwh REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_ev_monthly_usage_user_year ON ev_monthly_usage (user_id, year);
