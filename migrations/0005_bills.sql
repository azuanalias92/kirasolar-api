CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  system_code TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  peak_kwh REAL NOT NULL,
  off_peak_kwh REAL NOT NULL,
  total_kwh REAL NOT NULL,
  tariff_type TEXT NOT NULL,
  tariff_effective_date TEXT NOT NULL,
  energy_charge REAL NOT NULL,
  afa REAL NOT NULL,
  capacity_charge REAL NOT NULL,
  network_charge REAL NOT NULL,
  retail_charge REAL NOT NULL,
  efficiency_incentive REAL NOT NULL,
  subtotal REAL NOT NULL,
  taxable_subtotal REAL NOT NULL,
  service_tax REAL NOT NULL,
  kwtbb REAL NOT NULL,
  total_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_bills_user_created_at ON bills (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bills_user_system ON bills (user_id, system_code);
