CREATE TABLE IF NOT EXISTS tariff_rates (
  id TEXT PRIMARY KEY,
  tariff_type TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  peak_energy REAL NOT NULL,
  off_peak_energy REAL NOT NULL,
  capacity_rate REAL NOT NULL,
  network_rate REAL NOT NULL,
  retail_charge_rm REAL NOT NULL,
  afa_rate REAL NOT NULL,
  efficiency_incentive_rate REAL NOT NULL,
  service_tax_rate REAL NOT NULL,
  kwtbb_rate REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  UNIQUE(tariff_type, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_tariff_rates_type_date ON tariff_rates (tariff_type, effective_date);

INSERT OR IGNORE INTO tariff_rates (
  id,
  tariff_type,
  effective_date,
  peak_energy,
  off_peak_energy,
  capacity_rate,
  network_rate,
  retail_charge_rm,
  afa_rate,
  efficiency_incentive_rate,
  service_tax_rate,
  kwtbb_rate
) VALUES (
  'tnb_domestic_tou_2026_04_01',
  'TNB_DOMESTIC_TOU',
  '2026-04-01',
  0.2852,
  0.2443,
  0.0455,
  0.1285,
  10.0,
  -0.0047,
  -0.025,
  0.08,
  0.016
);
