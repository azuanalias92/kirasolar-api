-- Monthly Automatic Fuel Adjustment (AFA) rates, in RM/kWh (negative = rebate).
-- Announced monthly by TNB / Suruhanjaya Tenaga; kept current by the daily sync job.
CREATE TABLE IF NOT EXISTS afa_rates (
  month TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  rate REAL NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- Seed: TNB's published rates (myTNB tariff calculator, mytnb.com.my/tariff/js/rates.js).
INSERT OR IGNORE INTO afa_rates (month, rate, source) VALUES
  ('2025-07', 0.0, 'mytnb'),
  ('2025-08', -0.0145, 'mytnb'),
  ('2025-09', -0.0110, 'mytnb'),
  ('2025-10', -0.0650, 'mytnb'),
  ('2025-11', -0.0891, 'mytnb'),
  ('2025-12', -0.0642, 'mytnb'),
  ('2026-01', -0.0499, 'mytnb'),
  ('2026-02', -0.0277, 'mytnb'),
  ('2026-03', -0.0215, 'mytnb'),
  ('2026-04', -0.0047, 'mytnb'),
  ('2026-05', 0.0138, 'mytnb'),
  ('2026-06', 0.0259, 'mytnb'),
  ('2026-07', 0.0359, 'mytnb'),
  ('2026-08', 0.0380, 'mytnb'),
  ('2026-09', 0.0367, 'mytnb'),
  ('2026-10', 0.0361, 'mytnb');
