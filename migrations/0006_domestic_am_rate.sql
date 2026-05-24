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
  'tnb_domestic_am_2026_04_01',
  'TNB_DOMESTIC_AM',
  '2026-04-01',
  0.2703,
  0.2703,
  0.0455,
  0.1285,
  10.0,
  0.0,
  -0.145,
  0.08,
  0.016
);
