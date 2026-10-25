# kirasolar-api

Cloudflare Workers API for Kira Solar, built with Hono and backed by a Cloudflare D1 database.

## Tech

- Runtime: Cloudflare Workers
- Framework: Hono
- Database: Cloudflare D1 (SQLite)
- Auth: Google Identity Services (ID token) + session JWT (HS256)
- API docs: Swagger UI at `/docs`

## Local Development

Install dependencies:

```bash
npm install
```

Create your D1 DB (once) and apply migrations locally:

```bash
wrangler d1 create kirasolar-db
npm run db:migrate:local
```

Run the worker locally:

```bash
npm run dev
```

Swagger UI:

- http://localhost:8787/docs

## Configuration

Edit [wrangler.toml](file:///Users/azuanalias/Desktop/Personal/kirasolar-api/wrangler.toml) and set:

- `[[d1_databases]].database_id`

Set secrets (never commit these):

```bash
wrangler secret put AUTH_SECRET
wrangler secret put GOOGLE_CLIENT_ID
```

## Deploy

Apply migrations to the remote D1 database:

```bash
npm run db:migrate:remote
```

Deploy:

```bash
npm run deploy
```

## Monthly AFA rates

Bill estimates use each month's Automatic Fuel Adjustment (AFA) from the `afa_rates` table (RM/kWh, negative = rebate), and follow TNB's domestic rules: AFA, service tax and the RM10 retail charge only apply above 600 kWh a month (800 kWh for September to December 2026), service tax only covers usage above that threshold, the energy efficiency incentive is tiered by usage, and KWTBB applies above 300 kWh. The constants live next to `calculateDomesticBill` in `src/index.ts`.

- A daily cron (`[triggers]` in `wrangler.toml`, 02:00 UTC) reads TNB's published table (`FUEL_BY_MONTH` in `https://www.mytnb.com.my/tariff/js/rates.js`) and upserts months up to the current Malaysian month. Later months in that file are projections and are ignored. If the fetch fails, existing rates are kept.
- Months without a rate yet use the latest known rate, flagged `afaEstimated: true`.
- To set a rate by hand (for example from a TNB press release):

```bash
npx wrangler d1 execute kirasolar-db --remote --command "INSERT INTO afa_rates (month, rate, source) VALUES ('2026-11', 0.0427, 'manual') ON CONFLICT(month) DO UPDATE SET rate = excluded.rate, source = excluded.source, updated_at = CURRENT_TIMESTAMP"
```

Note: the daily sync overwrites a month if myTNB later publishes a different value for it.

- Test the sync locally: run `npm run dev`, then `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

## Main Endpoints

- **Docs**
  - `GET /docs` Swagger UI
  - `GET /openapi.json` OpenAPI spec
- **Auth**
  - `POST /auth/google` exchange Google ID token for `{ token, user }`
  - `GET /me` (Bearer token) returns current user
- **Solar Calculator (synced state)**
  - `GET /calculator/state`
  - `PUT /calculator/state`
- **EV Usage (per year)**
  - `GET /ev-usage?year=YYYY`
  - `PUT /ev-usage?year=YYYY`
  - `GET /ev-usage/years`
  - `GET /ev-sessions?year=YYYY` saved charging sessions
  - `POST /ev-sessions` save sessions; already stored ones are skipped and only new sessions' kWh is added to the monthly totals
- **Tariff Rates**
  - `GET /tariff-rates?tariffType=...&asOf=YYYY-MM-DD`
  - `GET /afa-rates` monthly AFA rates
- **Billing**
  - `POST /billing/tnb-domestic-tou/calculate`
  - `POST /billing/tnb-domestic-am/calculate`
  - `POST /billing/tnb-domestic-tou/bills` (auth)
  - `GET /billing/tnb-domestic-tou/bills` (auth)
  - `POST /billing/tnb-domestic-am/bills` (auth)
  - `GET /billing/tnb-domestic-am/bills` (auth)

