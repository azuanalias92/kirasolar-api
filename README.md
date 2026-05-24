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
- `[vars].GOOGLE_CLIENT_ID`

Set the session signing secret (never commit this):

```bash
wrangler secret put AUTH_SECRET
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
- **Tariff Rates**
  - `GET /tariff-rates?tariffType=...&asOf=YYYY-MM-DD`
- **Billing**
  - `POST /billing/tnb-domestic-tou/calculate`
  - `POST /billing/tnb-domestic-am/calculate`
  - `POST /billing/tnb-domestic-tou/bills` (auth)
  - `GET /billing/tnb-domestic-tou/bills` (auth)
  - `POST /billing/tnb-domestic-am/bills` (auth)
  - `GET /billing/tnb-domestic-am/bills` (auth)

