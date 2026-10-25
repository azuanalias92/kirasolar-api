-- Individual EV charging sessions (e.g. from Easy Charging statements).
-- A charger can't start two sessions at the same second, so (user_id, started_at)
-- identifies a session and stops the same statement being imported twice.
CREATE TABLE IF NOT EXISTS ev_charging_sessions (
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,   -- 'YYYY-MM-DD HH:MM:SS', local start time
  date TEXT NOT NULL,         -- start date, 'YYYY-MM-DD'
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  duration TEXT NOT NULL,     -- as printed on the statement, e.g. '09H27M'
  kwh REAL NOT NULL,
  cost REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (user_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_ev_charging_sessions_user_date ON ev_charging_sessions (user_id, date);
