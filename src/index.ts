import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { SignJWT, createRemoteJWKSet, jwtVerify } from 'jose'

type Env = {
  DB: D1Database
  GOOGLE_CLIENT_ID: string
  AUTH_SECRET: string
}

type NoteRow = {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
}

type UserRow = {
  id: string
  email: string | null
  name: string | null
  picture: string | null
  created_at: string
  updated_at: string
}

type SessionUser = {
  id: string
  email?: string
  name?: string
  picture?: string
}

type EvMonthlyUsageRow = {
  user_id: string
  year: number
  month: number
  ev_kwh: number
  non_ev_kwh: number
  updated_at: string
}

type DailyUsageRow = {
  user_id: string
  date: string
  peak_kwh: number
  off_peak_kwh: number
  created_at: string
  updated_at: string
}

type TariffRateRow = {
  id: string
  tariff_type: string
  effective_date: string
  peak_energy: number
  off_peak_energy: number
  capacity_rate: number
  network_rate: number
  retail_charge_rm: number
  afa_rate: number
  efficiency_incentive_rate: number
  service_tax_rate: number
  kwtbb_rate: number
}

type BillRow = {
  id: string
  user_id: string
  system_code: string
  period_start: string | null
  period_end: string | null
  peak_kwh: number
  off_peak_kwh: number
  total_kwh: number
  tariff_type: string
  tariff_effective_date: string
  energy_charge: number
  afa: number
  capacity_charge: number
  network_charge: number
  retail_charge: number
  efficiency_incentive: number
  subtotal: number
  taxable_subtotal: number
  service_tax: number
  kwtbb: number
  total_amount: number
  currency: string
  created_at: string
  updated_at: string
}

type CalculatorState = {
  items: Array<{
    id: string
    name: string
    watt: number
    quantity: number
    hoursUsage: number
    estimatekWh: number
  }>
  config: {
    peakSunHours: number
    panelWatts: number
    systemEfficiency: number
  }
}

function parseLimit(value: string | undefined): number {
  if (!value) return 50
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 200)
}

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${fieldName} is required`)
  }
  return trimmed
}

function assertNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number') {
    throw new Error(`${fieldName} must be a number`)
  }
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`)
  }
  return value
}

function parseYear(value: string | undefined): number {
  const year = value ? Number.parseInt(value, 10) : new Date().getFullYear()
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    throw new Error('year must be between 2000 and 2100')
  }
  return year
}

function assertDateString(value: unknown, fieldName: string): string {
  const s = assertString(value, fieldName)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`${fieldName} must be YYYY-MM-DD`)
  }
  const t = Date.parse(`${s}T00:00:00Z`)
  if (!Number.isFinite(t)) {
    throw new Error(`${fieldName} must be a valid date`)
  }
  return s
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function clampFiniteNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function parseCalculatorState(value: unknown): CalculatorState {
  const obj = value as Record<string, unknown>
  const itemsRaw = obj.items
  const configRaw = obj.config as Record<string, unknown> | undefined

  if (!Array.isArray(itemsRaw)) throw new Error('items must be an array')
  if (!configRaw || typeof configRaw !== 'object') throw new Error('config must be an object')

  const items = itemsRaw.slice(0, 300).map((item, idx) => {
    if (!item || typeof item !== 'object') throw new Error(`items[${idx}] must be an object`)
    const rec = item as Record<string, unknown>
    const id = assertString(rec.id, `items[${idx}].id`)
    const name = assertString(rec.name, `items[${idx}].name`)
    const watt = clampFiniteNumber(assertNumber(rec.watt, `items[${idx}].watt`), 0, 100000)
    const quantity = clampFiniteNumber(assertNumber(rec.quantity, `items[${idx}].quantity`), 0, 100000)
    const hoursUsage = clampFiniteNumber(assertNumber(rec.hoursUsage, `items[${idx}].hoursUsage`), 0, 24)
    const estimatekWh = clampFiniteNumber(assertNumber(rec.estimatekWh, `items[${idx}].estimatekWh`), 0, 100000)
    return { id, name, watt, quantity, hoursUsage, estimatekWh }
  })

  const peakSunHours = clampFiniteNumber(assertNumber(configRaw.peakSunHours, 'config.peakSunHours'), 0, 24)
  const panelWatts = clampFiniteNumber(assertNumber(configRaw.panelWatts, 'config.panelWatts'), 0, 100000)
  const systemEfficiency = clampFiniteNumber(assertNumber(configRaw.systemEfficiency, 'config.systemEfficiency'), 0, 100)

  return { items, config: { peakSunHours, panelWatts, systemEfficiency } }
}

const defaultCalculatorState: CalculatorState = {
  items: [],
  config: {
    peakSunHours: 5,
    panelWatts: 300,
    systemEfficiency: 85,
  },
}

async function getTariffRate(
  db: D1Database,
  tariffType: string,
  asOfDate: string,
): Promise<TariffRateRow | null> {
  return db
    .prepare(
      'SELECT id, tariff_type, effective_date, peak_energy, off_peak_energy, capacity_rate, network_rate, retail_charge_rm, afa_rate, efficiency_incentive_rate, service_tax_rate, kwtbb_rate FROM tariff_rates WHERE tariff_type = ?1 AND effective_date <= ?2 ORDER BY effective_date DESC LIMIT 1',
    )
    .bind(tariffType, asOfDate)
    .first<TariffRateRow>()
}

function calculateTnbDomesticTou(input: {
  peakKwh: number
  offPeakKwh: number
  rate: TariffRateRow
}): {
  peakKwh: number
  offPeakKwh: number
  totalKwh: number
  energyCharge: number
  afa: number
  capacityCharge: number
  networkCharge: number
  retailCharge: number
  efficiencyIncentive: number
  subtotal: number
  taxableSubtotal: number
  serviceTax: number
  kwtbb: number
  totalAmount: number
} {
  const peakKwh = Math.max(0, input.peakKwh)
  const offPeakKwh = Math.max(0, input.offPeakKwh)
  const totalKwh = peakKwh + offPeakKwh

  const energyCharge = peakKwh * input.rate.peak_energy + offPeakKwh * input.rate.off_peak_energy
  const afa = totalKwh * input.rate.afa_rate
  const capacityCharge = totalKwh * input.rate.capacity_rate
  const networkCharge = totalKwh * input.rate.network_rate
  const retailCharge = totalKwh > 600 ? input.rate.retail_charge_rm : 0
  const efficiencyIncentive = totalKwh * input.rate.efficiency_incentive_rate

  const subtotal = energyCharge + capacityCharge + networkCharge + retailCharge + afa + efficiencyIncentive
  const taxableSubtotal = totalKwh > 600 ? subtotal : 0
  const serviceTax = taxableSubtotal * input.rate.service_tax_rate
  const kwtbb = subtotal * input.rate.kwtbb_rate
  const totalAmount = subtotal + serviceTax + kwtbb

  return {
    peakKwh,
    offPeakKwh,
    totalKwh,
    energyCharge,
    afa,
    capacityCharge,
    networkCharge,
    retailCharge,
    efficiencyIncentive,
    subtotal,
    taxableSubtotal,
    serviceTax,
    kwtbb,
    totalAmount,
  }
}

function prorateFactor(periodStart: string | undefined, periodEnd: string | undefined): number {
  if (!periodStart || !periodEnd) return 1
  const start = Date.parse(`${periodStart}T00:00:00Z`)
  const end = Date.parse(`${periodEnd}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1
  const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)))
  return Math.max(0, Math.min(2, days / 30))
}

function calculateTnbDomesticAm(input: {
  usageKwh: number
  rate: TariffRateRow
  periodStart?: string
  periodEnd?: string
}): {
  usageKwh: number
  energyCharge: number
  afa: number
  capacityCharge: number
  networkCharge: number
  retailCharge: number
  efficiencyIncentive: number
  subtotal: number
  taxableSubtotal: number
  serviceTax: number
  kwtbb: number
  totalAmount: number
} {
  const usageKwh = Math.max(0, input.usageKwh)

  const energyCharge = usageKwh * input.rate.peak_energy
  const capacityCharge = usageKwh * input.rate.capacity_rate
  const networkCharge = usageKwh * input.rate.network_rate
  const retailCharge = usageKwh > 600 ? input.rate.retail_charge_rm : 0
  const efficiencyIncentive = usageKwh * input.rate.efficiency_incentive_rate

  const afaFactor = usageKwh > 600 ? prorateFactor(input.periodStart, input.periodEnd) : 0
  const afa = usageKwh > 600 ? usageKwh * input.rate.afa_rate * afaFactor : 0

  const subtotal = energyCharge + capacityCharge + networkCharge + retailCharge + afa + efficiencyIncentive
  const taxableSubtotal = usageKwh > 600 ? subtotal : 0
  const serviceTax = taxableSubtotal * input.rate.service_tax_rate
  const kwtbb = subtotal * input.rate.kwtbb_rate
  const totalAmount = subtotal + serviceTax + kwtbb

  return {
    usageKwh,
    energyCharge,
    afa,
    capacityCharge,
    networkCharge,
    retailCharge,
    efficiencyIncentive,
    subtotal,
    taxableSubtotal,
    serviceTax,
    kwtbb,
    totalAmount,
  }
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))

function getBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix)) return null
  const token = authorization.slice(prefix.length).trim()
  return token ? token : null
}

function getSessionSecret(env: Env): Uint8Array {
  return new TextEncoder().encode(env.AUTH_SECRET)
}

async function issueSessionToken(env: Env, user: SessionUser): Promise<string> {
  const secret = getSessionSecret(env)
  return new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('kirasolar-api')
    .setAudience('kirasolar-frontend')
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setNotBefore()
    .setExpirationTime('7d')
    .sign(secret)
}

async function verifySessionToken(env: Env, token: string): Promise<SessionUser> {
  const secret = getSessionSecret(env)
  const { payload } = await jwtVerify(token, secret, {
    issuer: 'kirasolar-api',
    audience: 'kirasolar-frontend',
  })

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Invalid token')
  }

  const user: SessionUser = { id: payload.sub }
  if (typeof payload.email === 'string') user.email = payload.email
  if (typeof payload.name === 'string') user.name = payload.name
  if (typeof payload.picture === 'string') user.picture = payload.picture
  return user
}

async function requireUser(env: Env, authorization: string | undefined): Promise<SessionUser> {
  const token = getBearerToken(authorization)
  if (!token) {
    throw new Error('Unauthorized')
  }
  return verifySessionToken(env, token)
}

function buildOpenApiSpec(origin: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'KiraSolar API',
      version: '1.0.0',
    },
    servers: [{ url: origin }],
    tags: [
      { name: 'System' },
      { name: 'Docs' },
      { name: 'Auth' },
      { name: 'Calculator' },
      { name: 'EV Usage' },
      { name: 'Daily Usage' },
      { name: 'Tariff Rates' },
      { name: 'Billing - ToU' },
      { name: 'Billing - Domestik Am' },
      { name: 'Notes' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        HealthResponse: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        SessionUser: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            picture: { type: 'string', nullable: true },
          },
          required: ['id'],
        },
        AuthGoogleRequest: {
          type: 'object',
          properties: { credential: { type: 'string' } },
          required: ['credential'],
        },
        AuthGoogleResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: { $ref: '#/components/schemas/SessionUser' },
          },
          required: ['token', 'user'],
        },
        CalculatorItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            watt: { type: 'number' },
            quantity: { type: 'number' },
            hoursUsage: { type: 'number' },
            estimatekWh: { type: 'number' },
          },
          required: ['id', 'name', 'watt', 'quantity', 'hoursUsage', 'estimatekWh'],
        },
        CalculatorConfig: {
          type: 'object',
          properties: {
            peakSunHours: { type: 'number' },
            panelWatts: { type: 'number' },
            systemEfficiency: { type: 'number' },
          },
          required: ['peakSunHours', 'panelWatts', 'systemEfficiency'],
        },
        CalculatorState: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/CalculatorItem' } },
            config: { $ref: '#/components/schemas/CalculatorConfig' },
          },
          required: ['items', 'config'],
        },
        EvUsageItem: {
          type: 'object',
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            evKwh: { type: 'number' },
            nonEvKwh: { type: 'number' },
          },
          required: ['month', 'evKwh', 'nonEvKwh'],
        },
        TariffRate: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tariff_type: { type: 'string' },
            effective_date: { type: 'string' },
            peak_energy: { type: 'number' },
            off_peak_energy: { type: 'number' },
            capacity_rate: { type: 'number' },
            network_rate: { type: 'number' },
            retail_charge_rm: { type: 'number' },
            afa_rate: { type: 'number' },
            efficiency_incentive_rate: { type: 'number' },
            service_tax_rate: { type: 'number' },
            kwtbb_rate: { type: 'number' },
          },
          required: [
            'id',
            'tariff_type',
            'effective_date',
            'peak_energy',
            'off_peak_energy',
            'capacity_rate',
            'network_rate',
            'retail_charge_rm',
            'afa_rate',
            'efficiency_incentive_rate',
            'service_tax_rate',
            'kwtbb_rate',
          ],
        },
        BillingTouCalculateRequest: {
          type: 'object',
          properties: {
            peakKwh: { type: 'number' },
            offPeakKwh: { type: 'number' },
            asOfDate: { type: 'string', example: '2026-04-15' },
          },
          required: ['peakKwh', 'offPeakKwh'],
        },
        BillingAmCalculateRequest: {
          type: 'object',
          properties: {
            usageKwh: { type: 'number' },
            asOfDate: { type: 'string', example: '2026-04-15' },
            periodStart: { type: 'string', example: '2026-03-16' },
            periodEnd: { type: 'string', example: '2026-04-15' },
          },
          required: ['usageKwh'],
        },
        DailyUsageItem: {
          type: 'object',
          properties: {
            date: { type: 'string', example: '2026-05-01' },
            peakKwh: { type: 'number' },
            offPeakKwh: { type: 'number' },
          },
          required: ['date', 'peakKwh', 'offPeakKwh'],
        },
        DailyUsageSummaryItem: {
          type: 'object',
          properties: {
            month: { type: 'integer', minimum: 1, maximum: 12 },
            peakKwh: { type: 'number' },
            offPeakKwh: { type: 'number' },
            totalKwh: { type: 'number' },
            billAmount: { type: 'number', nullable: true },
          },
          required: ['month', 'peakKwh', 'offPeakKwh', 'totalKwh', 'billAmount'],
        },
        Note: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
          required: ['id', 'title', 'content', 'created_at', 'updated_at'],
        },
      },
    },
    paths: {
      '/openapi.json': {
        get: {
          tags: ['Docs'],
          summary: 'OpenAPI spec',
          responses: {
            '200': {
              description: 'OpenAPI JSON',
            },
          },
        },
      },
      '/docs': {
        get: {
          tags: ['Docs'],
          summary: 'Swagger UI',
          responses: {
            '200': {
              description: 'Swagger UI HTML',
            },
          },
        },
      },
      '/health': {
        get: {
          tags: ['System'],
          summary: 'Health check',
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
            },
          },
        },
      },
      '/auth/google': {
        post: {
          tags: ['Auth'],
          summary: 'Login with Google (ID token)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthGoogleRequest' } } },
          },
          responses: {
            '200': {
              description: 'Session created',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthGoogleResponse' } } },
            },
            '400': { description: 'Bad Request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/me': {
        get: {
          tags: ['Auth'],
          summary: 'Get current user from session token',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'User',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/SessionUser' } }, required: ['user'] },
                },
              },
            },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/calculator/state': {
        get: {
          tags: ['Calculator'],
          summary: 'Get calculator state',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'State',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/CalculatorState' } }, required: ['data'] },
                },
              },
            },
          },
        },
        put: {
          tags: ['Calculator'],
          summary: 'Save calculator state',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CalculatorState' } } },
          },
          responses: {
            '200': {
              description: 'Saved',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/CalculatorState' } }, required: ['data'] },
                },
              },
            },
          },
        },
      },
      '/ev-usage': {
        get: {
          tags: ['EV Usage'],
          summary: 'Get EV monthly usage for a year',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'Usage',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { year: { type: 'integer' }, data: { type: 'array', items: { $ref: '#/components/schemas/EvUsageItem' } } },
                    required: ['year', 'data'],
                  },
                },
              },
            },
          },
        },
        put: {
          tags: ['EV Usage'],
          summary: 'Save EV monthly usage for a year',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'year', in: 'query', required: false, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/EvUsageItem' } } }, required: ['data'] },
              },
            },
          },
          responses: { '200': { description: 'Saved' } },
        },
      },
      '/ev-usage/years': {
        get: {
          tags: ['EV Usage'],
          summary: 'List years that have EV usage data',
          security: [{ bearerAuth: [] }],
          responses: {
            '200': {
              description: 'Years',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { years: { type: 'array', items: { type: 'integer' } } }, required: ['years'] },
                },
              },
            },
          },
        },
      },
      '/daily-usage': {
        get: {
          tags: ['Daily Usage'],
          summary: 'Get daily ToU usage for a month',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'year', in: 'query', required: false, schema: { type: 'integer' } },
            { name: 'month', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 12 } },
          ],
          responses: {
            '200': {
              description: 'Daily readings',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      year: { type: 'integer' },
                      month: { type: 'integer' },
                      data: { type: 'array', items: { $ref: '#/components/schemas/DailyUsageItem' } },
                    },
                    required: ['year', 'month', 'data'],
                  },
                },
              },
            },
          },
        },
        put: {
          tags: ['Daily Usage'],
          summary: 'Batch save/update daily ToU readings',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/DailyUsageItem' } },
                  },
                  required: ['data'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Saved' },
          },
        },
      },
      '/daily-usage/summary': {
        get: {
          tags: ['Daily Usage'],
          summary: 'Get monthly usage summary with auto bill calculation',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'year', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: {
            '200': {
              description: 'Monthly summaries',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      year: { type: 'integer' },
                      data: { type: 'array', items: { $ref: '#/components/schemas/DailyUsageSummaryItem' } },
                    },
                    required: ['year', 'data'],
                  },
                },
              },
            },
          },
        },
      },
      '/tariff-rates': {
        get: {
          tags: ['Tariff Rates'],
          summary: 'Get tariff rate as-of a date',
          parameters: [
            { name: 'tariffType', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'asOf', in: 'query', required: false, schema: { type: 'string', example: '2026-04-15' } },
          ],
          responses: {
            '200': {
              description: 'Rate',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/TariffRate' } }, required: ['data'] },
                },
              },
            },
            '404': { description: 'Not Found' },
          },
        },
      },
      '/billing/tnb-domestic-tou/calculate': {
        post: {
          tags: ['Billing - ToU'],
          summary: 'Calculate TNB Domestic ToU bill',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingTouCalculateRequest' } } } },
          responses: { '200': { description: 'Breakdown' } },
        },
      },
      '/billing/tnb-domestic-am/calculate': {
        post: {
          tags: ['Billing - Domestik Am'],
          summary: 'Calculate TNB Domestik Am bill',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingAmCalculateRequest' } } } },
          responses: { '200': { description: 'Breakdown' } },
        },
      },
      '/billing/tnb-domestic-tou/bills': {
        get: {
          tags: ['Billing - ToU'],
          summary: 'List saved ToU bills',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Bills' } },
        },
        post: {
          tags: ['Billing - ToU'],
          summary: 'Save a ToU bill calculation',
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingTouCalculateRequest' } } } },
          responses: { '201': { description: 'Saved' } },
        },
      },
      '/billing/tnb-domestic-am/bills': {
        get: {
          tags: ['Billing - Domestik Am'],
          summary: 'List saved Domestik Am bills',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Bills' } },
        },
        post: {
          tags: ['Billing - Domestik Am'],
          summary: 'Save a Domestik Am bill calculation',
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingAmCalculateRequest' } } } },
          responses: { '201': { description: 'Saved' } },
        },
      },
      '/notes': {
        get: {
          tags: ['Notes'],
          summary: 'List notes',
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
          responses: {
            '200': {
              description: 'Notes',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Note' } } }, required: ['data'] },
                },
              },
            },
          },
        },
        post: {
          tags: ['Notes'],
          summary: 'Create note',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'] },
              },
            },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/notes/{id}': {
        get: {
          tags: ['Notes'],
          summary: 'Get note',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Note' }, '404': { description: 'Not Found' } },
        },
        put: {
          tags: ['Notes'],
          summary: 'Update note',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'Updated' }, '404': { description: 'Not Found' } },
        },
        delete: {
          tags: ['Notes'],
          summary: 'Delete note',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Not Found' } },
        },
      },
    },
  } as const
}

const app = new Hono<{ Bindings: Env }>()

app.use('*', logger())

// Allowed frontend origins
const ALLOWED_ORIGINS = [
  'https://solar-calculator.vercel.app',
  'https://kirasolar.pages.dev',
]

app.use(
  '*',
  cors({
    origin: (origin) => {
      // Allow requests with no origin (server-to-server, mobile apps, curl)
      if (!origin) return origin
      if (ALLOWED_ORIGINS.includes(origin)) return origin
      // Allow localhost in development
      if (origin.startsWith('http://localhost:')) return origin
      return ALLOWED_ORIGINS[0]
    },
    allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    credentials: true,
  }),
)

app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 })) // 1MB

// Security headers middleware
app.use('*', async (c, next) => {
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('X-Frame-Options', 'DENY')
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  await next()
})

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(key: string, windowMs: number, limit: number): boolean {
  const now = Date.now()
  const entry = rateLimitStore.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (entry.count >= limit) return false
  entry.count++
  return true
}

app.use('/auth/*', async (c, next) => {
  const key = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(`auth:${key}`, 15 * 60 * 1000, 20)) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429)
  }
  await next()
})

app.use('*', async (c, next) => {
  const key = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(`global:${key}`, 60 * 1000, 100)) {
    return c.json({ error: 'Too many requests. Please try again later.' }, 429)
  }
  await next()
})

app.get('/health', (c) => c.json({ ok: true }))

app.get('/openapi.json', (c) => {
  const origin = new URL(c.req.url).origin
  return c.json(buildOpenApiSpec(origin))
})

app.get('/docs', (c) => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>KiraSolar API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        persistAuthorization: true
      });
    </script>
  </body>
</html>`
  return c.html(html)
})

app.post('/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.AUTH_SECRET) {
    return c.json({ error: 'Server misconfigured' }, 500)
  }

  const body = await c.req.json().catch(() => ({}))
  let credential: string
  try {
    credential = assertString((body as Record<string, unknown>).credential, 'credential')
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      400,
    )
  }

  let googleUserId: string
  let email: string | undefined
  let name: string | undefined
  let picture: string | undefined
  try {
    const { payload } = await jwtVerify(credential, googleJwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: c.env.GOOGLE_CLIENT_ID,
    })

    if (typeof payload.sub !== 'string' || !payload.sub) {
      return c.json({ error: 'Invalid Google token' }, 401)
    }

    const emailVerified = payload.email_verified
    if (emailVerified === false) {
      return c.json({ error: 'Email not verified' }, 401)
    }

    googleUserId = payload.sub
    if (typeof payload.email === 'string') email = payload.email
    if (typeof payload.name === 'string') name = payload.name
    if (typeof payload.picture === 'string') picture = payload.picture
  } catch {
    return c.json({ error: 'Invalid Google token' }, 401)
  }

  await c.env.DB.prepare(
    'INSERT INTO users (id, email, name, picture, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture, updated_at = CURRENT_TIMESTAMP',
  )
    .bind(googleUserId, email ?? null, name ?? null, picture ?? null)
    .run()

  const userRow = await c.env.DB.prepare(
    'SELECT id, email, name, picture, created_at, updated_at FROM users WHERE id = ?1',
  )
    .bind(googleUserId)
    .first<UserRow>()

  const user: SessionUser = {
    id: googleUserId,
    email: userRow?.email ?? email,
    name: userRow?.name ?? name,
    picture: userRow?.picture ?? picture,
  }
  const token = await issueSessionToken(c.env, user)
  return c.json({ token, user })
})

app.get('/me', async (c) => {
  const token = getBearerToken(c.req.header('authorization'))
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const user = await verifySessionToken(c.env, token)
    return c.json({ user })
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }
})

app.get('/calculator/state', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const row = await c.env.DB.prepare('SELECT state_json FROM calculator_state WHERE user_id = ?1')
    .bind(user.id)
    .first<{ state_json: string }>()

  if (!row) return c.json({ data: defaultCalculatorState })

  try {
    const parsed = JSON.parse(row.state_json) as unknown
    const state = parseCalculatorState(parsed)
    return c.json({ data: state })
  } catch {
    return c.json({ data: defaultCalculatorState })
  }
})

app.put('/calculator/state', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  let state: CalculatorState
  try {
    state = parseCalculatorState(body)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid request body' }, 400)
  }

  const json = JSON.stringify(state)
  await c.env.DB.prepare(
    'INSERT INTO calculator_state (user_id, state_json, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP',
  )
    .bind(user.id, json)
    .run()

  return c.json({ data: state })
})

app.get('/ev-usage', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let year: number
  try {
    year = parseYear(c.req.query('year'))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid year' }, 400)
  }

  const result = await c.env.DB.prepare(
    'SELECT user_id, year, month, ev_kwh, non_ev_kwh, updated_at FROM ev_monthly_usage WHERE user_id = ?1 AND year = ?2',
  )
    .bind(user.id, year)
    .all<EvMonthlyUsageRow>()

  const byMonth = new Map<number, EvMonthlyUsageRow>()
  for (const row of result.results) {
    byMonth.set(row.month, row)
  }

  const data = Array.from({ length: 12 }, (_, idx) => {
    const month = idx + 1
    const row = byMonth.get(month)
    return {
      month,
      evKwh: row?.ev_kwh ?? 0,
      nonEvKwh: row?.non_ev_kwh ?? 0,
    }
  })

  return c.json({ year, data })
})

app.get('/ev-usage/years', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const result = await c.env.DB.prepare(
    'SELECT DISTINCT year FROM ev_monthly_usage WHERE user_id = ?1 ORDER BY year DESC',
  )
    .bind(user.id)
    .all<{ year: number }>()

  const years = result.results.map((r) => r.year)
  return c.json({ years })
})

app.put('/ev-usage', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let year: number
  try {
    year = parseYear(c.req.query('year'))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid year' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const itemsRaw = (body as Record<string, unknown>).data
  if (!Array.isArray(itemsRaw)) return c.json({ error: 'data must be an array' }, 400)

  const rows = itemsRaw
    .map((item, idx) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`data[${idx}] must be an object`)
      }
      const rec = item as Record<string, unknown>
      const month = assertNumber(rec.month, `data[${idx}].month`)
      const evKwh = assertNumber(rec.evKwh, `data[${idx}].evKwh`)
      const nonEvKwh = assertNumber(rec.nonEvKwh, `data[${idx}].nonEvKwh`)
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new Error(`data[${idx}].month must be an integer 1..12`)
      }
      const ev = Math.max(0, evKwh)
      const nonEv = Math.max(0, nonEvKwh)
      return { month, evKwh: ev, nonEvKwh: nonEv }
    })
    .slice(0, 12)

  try {
    const statements = rows.map((r) =>
      c.env.DB.prepare(
        'INSERT INTO ev_monthly_usage (user_id, year, month, ev_kwh, non_ev_kwh, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP) ON CONFLICT(user_id, year, month) DO UPDATE SET ev_kwh = excluded.ev_kwh, non_ev_kwh = excluded.non_ev_kwh, updated_at = CURRENT_TIMESTAMP',
      ).bind(user.id, year, r.month, r.evKwh, r.nonEvKwh),
    )
    if (statements.length > 0) {
      await c.env.DB.batch(statements)
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to save' }, 500)
  }

  const result = await c.env.DB.prepare(
    'SELECT user_id, year, month, ev_kwh, non_ev_kwh, updated_at FROM ev_monthly_usage WHERE user_id = ?1 AND year = ?2',
  )
    .bind(user.id, year)
    .all<EvMonthlyUsageRow>()

  const byMonth = new Map<number, EvMonthlyUsageRow>()
  for (const row of result.results) {
    byMonth.set(row.month, row)
  }

  const data = Array.from({ length: 12 }, (_, idx) => {
    const month = idx + 1
    const row = byMonth.get(month)
    return {
      month,
      evKwh: row?.ev_kwh ?? 0,
      nonEvKwh: row?.non_ev_kwh ?? 0,
    }
  })

  return c.json({ year, data })
})

// ── Daily Usage ─────────────────────────────────────────────

app.get('/daily-usage', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let year: number
  let month: number | undefined
  try {
    year = parseYear(c.req.query('year'))
    const m = c.req.query('month')
    if (m !== undefined) {
      month = Number.parseInt(m, 10)
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return c.json({ error: 'month must be 1..12' }, 400)
      }
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid params' }, 400)
  }

  const datePrefix = month !== undefined
    ? `${year}-${String(month).padStart(2, '0')}`
    : `${year}`

  const result = await c.env.DB.prepare(
    'SELECT user_id, date, peak_kwh, off_peak_kwh, created_at, updated_at FROM daily_usage WHERE user_id = ?1 AND date LIKE ?2 ORDER BY date ASC',
  )
    .bind(user.id, `${datePrefix}%`)
    .all<DailyUsageRow>()

  const data = result.results.map((r) => ({
    date: r.date,
    peakKwh: r.peak_kwh,
    offPeakKwh: r.off_peak_kwh,
  }))

  return c.json({ year, month: month ?? null, data })
})

app.put('/daily-usage', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  const itemsRaw = (body as Record<string, unknown>).data
  if (!Array.isArray(itemsRaw)) return c.json({ error: 'data must be an array' }, 400)

  const rows: Array<{ date: string; peakKwh: number; offPeakKwh: number }> = []
  for (let i = 0; i < itemsRaw.length; i++) {
    const item = itemsRaw[i]
    if (typeof item !== 'object' || item === null) {
      return c.json({ error: `data[${i}] must be an object` }, 400)
    }
    const rec = item as Record<string, unknown>
    let date: string
    let peakKwh: number
    let offPeakKwh: number
    try {
      date = assertDateString(rec.date, `data[${i}].date`)
      peakKwh = Math.max(0, assertNumber(rec.peakKwh, `data[${i}].peakKwh`))
      offPeakKwh = Math.max(0, assertNumber(rec.offPeakKwh, `data[${i}].offPeakKwh`))
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : `Invalid data[${i}]` }, 400)
    }
    rows.push({ date, peakKwh, offPeakKwh })
  }

  if (rows.length === 0) return c.json({ error: 'No valid items' }, 400)

  try {
    const statements = rows.map((r) =>
      c.env.DB.prepare(
        'INSERT INTO daily_usage (user_id, date, peak_kwh, off_peak_kwh, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(user_id, date) DO UPDATE SET peak_kwh = excluded.peak_kwh, off_peak_kwh = excluded.off_peak_kwh, updated_at = CURRENT_TIMESTAMP',
      ).bind(user.id, r.date, r.peakKwh, r.offPeakKwh),
    )
    await c.env.DB.batch(statements)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to save' }, 500)
  }

  // Fetch back the saved data
  const minDate = rows.reduce((a, b) => (a.date < b.date ? a : b)).date
  const maxDate = rows.reduce((a, b) => (a.date > b.date ? a : b)).date
  const result = await c.env.DB.prepare(
    'SELECT user_id, date, peak_kwh, off_peak_kwh, created_at, updated_at FROM daily_usage WHERE user_id = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date ASC',
  )
    .bind(user.id, minDate, maxDate)
    .all<DailyUsageRow>()

  const data = result.results.map((r) => ({
    date: r.date,
    peakKwh: r.peak_kwh,
    offPeakKwh: r.off_peak_kwh,
  }))

  return c.json({ data })
})

app.get('/daily-usage/summary', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let year: number
  try {
    year = parseYear(c.req.query('year'))
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid year' }, 400)
  }

  // Fetch all daily data for the year
  const result = await c.env.DB.prepare(
    "SELECT date, peak_kwh, off_peak_kwh FROM daily_usage WHERE user_id = ?1 AND date LIKE ?2 ORDER BY date ASC",
  )
    .bind(user.id, `${year}%`)
    .all<{ date: string; peak_kwh: number; off_peak_kwh: number }>()

  // Aggregate by month
  const monthly = new Map<number, { peakKwh: number; offPeakKwh: number }>()
  for (const row of result.results) {
    const month = Number.parseInt(row.date.slice(5, 7), 10)
    const existing = monthly.get(month) ?? { peakKwh: 0, offPeakKwh: 0 }
    existing.peakKwh += row.peak_kwh
    existing.offPeakKwh += row.off_peak_kwh
    monthly.set(month, existing)
  }

  // Get the latest tariff rate for auto-bill calculation
  const rate = await getTariffRate(c.env.DB, 'TNB_DOMESTIC_TOU', `${year}-12-31`)

  const data = Array.from({ length: 12 }, (_, idx) => {
    const month = idx + 1
    const agg = monthly.get(month)
    if (!agg) {
      return { month, peakKwh: 0, offPeakKwh: 0, totalKwh: 0, billAmount: null }
    }
    const peakKwh = round2(agg.peakKwh)
    const offPeakKwh = round2(agg.offPeakKwh)
    const totalKwh = round2(peakKwh + offPeakKwh)

    let billAmount: number | null = null
    if (rate) {
      const calc = calculateTnbDomesticTou({ peakKwh, offPeakKwh, rate })
      billAmount = round2(calc.totalAmount)
    }

    return { month, peakKwh, offPeakKwh, totalKwh, billAmount }
  })

  return c.json({ year, data })
})

app.get('/tariff-rates', async (c) => {
  const VALID_TARIFF_TYPES = ['TNB_DOMESTIC_TOU', 'TNB_DOMESTIC_AM']
  const tariffType = c.req.query('tariffType') ?? 'TNB_DOMESTIC_TOU'
  if (!VALID_TARIFF_TYPES.includes(tariffType)) {
    return c.json({ error: `Invalid tariffType. Must be one of: ${VALID_TARIFF_TYPES.join(', ')}` }, 400)
  }
  const asOf = c.req.query('asOf') ?? new Date().toISOString().slice(0, 10)

  try {
    assertDateString(asOf, 'asOf')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid asOf' }, 400)
  }

  const rate = await getTariffRate(c.env.DB, tariffType, asOf)
  if (!rate) return c.json({ error: 'Not Found' }, 404)
  return c.json({ data: rate })
})

app.post('/billing/tnb-domestic-tou/calculate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let peakKwh: number
  let offPeakKwh: number
  let asOfDate: string

  try {
    peakKwh = assertNumber((body as Record<string, unknown>).peakKwh, 'peakKwh')
    offPeakKwh = assertNumber((body as Record<string, unknown>).offPeakKwh, 'offPeakKwh')
    asOfDate = assertDateString((body as Record<string, unknown>).asOfDate ?? new Date().toISOString().slice(0, 10), 'asOfDate')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid request body' }, 400)
  }

  const rate = await getTariffRate(c.env.DB, 'TNB_DOMESTIC_TOU', asOfDate)
  if (!rate) return c.json({ error: 'No tariff rate found' }, 404)

  const calc = calculateTnbDomesticTou({ peakKwh, offPeakKwh, rate })

  return c.json({
    tariff: rate,
    breakdown: {
      peakKwh: round2(calc.peakKwh),
      offPeakKwh: round2(calc.offPeakKwh),
      totalKwh: round2(calc.totalKwh),
      energyCharge: round2(calc.energyCharge),
      afa: round2(calc.afa),
      capacityCharge: round2(calc.capacityCharge),
      networkCharge: round2(calc.networkCharge),
      retailCharge: round2(calc.retailCharge),
      efficiencyIncentive: round2(calc.efficiencyIncentive),
      subtotal: round2(calc.subtotal),
      taxableSubtotal: round2(calc.taxableSubtotal),
      serviceTax: round2(calc.serviceTax),
      kwtbb: round2(calc.kwtbb),
      totalAmount: round2(calc.totalAmount),
      currency: 'MYR',
    },
  })
})

app.post('/billing/tnb-domestic-am/calculate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let usageKwh: number
  let asOfDate: string
  let periodStart: string | undefined
  let periodEnd: string | undefined

  try {
    usageKwh = assertNumber((body as Record<string, unknown>).usageKwh, 'usageKwh')
    asOfDate = assertDateString((body as Record<string, unknown>).asOfDate ?? new Date().toISOString().slice(0, 10), 'asOfDate')
    const ps = (body as Record<string, unknown>).periodStart
    const pe = (body as Record<string, unknown>).periodEnd
    if (ps !== undefined) periodStart = assertDateString(ps, 'periodStart')
    if (pe !== undefined) periodEnd = assertDateString(pe, 'periodEnd')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid request body' }, 400)
  }

  const rate = await getTariffRate(c.env.DB, 'TNB_DOMESTIC_AM', asOfDate)
  if (!rate) return c.json({ error: 'No tariff rate found' }, 404)

  const calc = calculateTnbDomesticAm({ usageKwh, rate, periodStart, periodEnd })

  return c.json({
    tariff: rate,
    breakdown: {
      usageKwh: round2(calc.usageKwh),
      energyCharge: round2(calc.energyCharge),
      afa: round2(calc.afa),
      capacityCharge: round2(calc.capacityCharge),
      networkCharge: round2(calc.networkCharge),
      retailCharge: round2(calc.retailCharge),
      efficiencyIncentive: round2(calc.efficiencyIncentive),
      subtotal: round2(calc.subtotal),
      taxableSubtotal: round2(calc.taxableSubtotal),
      serviceTax: round2(calc.serviceTax),
      kwtbb: round2(calc.kwtbb),
      totalAmount: round2(calc.totalAmount),
      currency: 'MYR',
    },
  })
})

app.post('/billing/tnb-domestic-tou/bills', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  let peakKwh: number
  let offPeakKwh: number
  let asOfDate: string
  let periodStart: string | undefined
  let periodEnd: string | undefined

  try {
    peakKwh = assertNumber((body as Record<string, unknown>).peakKwh, 'peakKwh')
    offPeakKwh = assertNumber((body as Record<string, unknown>).offPeakKwh, 'offPeakKwh')
    asOfDate = assertDateString((body as Record<string, unknown>).asOfDate ?? new Date().toISOString().slice(0, 10), 'asOfDate')
    const ps = (body as Record<string, unknown>).periodStart
    const pe = (body as Record<string, unknown>).periodEnd
    if (ps !== undefined) periodStart = assertDateString(ps, 'periodStart')
    if (pe !== undefined) periodEnd = assertDateString(pe, 'periodEnd')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid request body' }, 400)
  }

  const rate = await getTariffRate(c.env.DB, 'TNB_DOMESTIC_TOU', asOfDate)
  if (!rate) return c.json({ error: 'No tariff rate found' }, 404)

  const calc = calculateTnbDomesticTou({ peakKwh, offPeakKwh, rate })
  const id = crypto.randomUUID()

  await c.env.DB.prepare(
    'INSERT INTO bills (id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  )
    .bind(
      id,
      user.id,
      'TNB_DOMESTIC_TOU',
      periodStart ?? null,
      periodEnd ?? null,
      round2(calc.peakKwh),
      round2(calc.offPeakKwh),
      round2(calc.totalKwh),
      rate.tariff_type,
      rate.effective_date,
      round2(calc.energyCharge),
      round2(calc.afa),
      round2(calc.capacityCharge),
      round2(calc.networkCharge),
      round2(calc.retailCharge),
      round2(calc.efficiencyIncentive),
      round2(calc.subtotal),
      round2(calc.taxableSubtotal),
      round2(calc.serviceTax),
      round2(calc.kwtbb),
      round2(calc.totalAmount),
      'MYR',
    )
    .run()

  const bill = await c.env.DB.prepare(
    'SELECT id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at FROM bills WHERE id = ?1 AND user_id = ?2',
  )
    .bind(id, user.id)
    .first<BillRow>()

  return c.json({ data: bill }, 201)
})

app.get('/billing/tnb-domestic-tou/bills', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const limit = parseLimit(c.req.query('limit'))
  const result = await c.env.DB.prepare(
    'SELECT id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at FROM bills WHERE user_id = ?1 AND system_code = ?2 ORDER BY created_at DESC LIMIT ?3',
  )
    .bind(user.id, 'TNB_DOMESTIC_TOU', limit)
    .all<BillRow>()

  return c.json({ data: result.results })
})

app.post('/billing/tnb-domestic-am/bills', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))
  let usageKwh: number
  let asOfDate: string
  let periodStart: string | undefined
  let periodEnd: string | undefined

  try {
    usageKwh = assertNumber((body as Record<string, unknown>).usageKwh, 'usageKwh')
    asOfDate = assertDateString((body as Record<string, unknown>).asOfDate ?? new Date().toISOString().slice(0, 10), 'asOfDate')
    const ps = (body as Record<string, unknown>).periodStart
    const pe = (body as Record<string, unknown>).periodEnd
    if (ps !== undefined) periodStart = assertDateString(ps, 'periodStart')
    if (pe !== undefined) periodEnd = assertDateString(pe, 'periodEnd')
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid request body' }, 400)
  }

  const rate = await getTariffRate(c.env.DB, 'TNB_DOMESTIC_AM', asOfDate)
  if (!rate) return c.json({ error: 'No tariff rate found' }, 404)

  const calc = calculateTnbDomesticAm({ usageKwh, rate, periodStart, periodEnd })
  const id = crypto.randomUUID()

  await c.env.DB.prepare(
    'INSERT INTO bills (id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  )
    .bind(
      id,
      user.id,
      'TNB_DOMESTIC_AM',
      periodStart ?? null,
      periodEnd ?? null,
      0,
      0,
      round2(calc.usageKwh),
      rate.tariff_type,
      rate.effective_date,
      round2(calc.energyCharge),
      round2(calc.afa),
      round2(calc.capacityCharge),
      round2(calc.networkCharge),
      round2(calc.retailCharge),
      round2(calc.efficiencyIncentive),
      round2(calc.subtotal),
      round2(calc.taxableSubtotal),
      round2(calc.serviceTax),
      round2(calc.kwtbb),
      round2(calc.totalAmount),
      'MYR',
    )
    .run()

  const bill = await c.env.DB.prepare(
    'SELECT id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at FROM bills WHERE id = ?1 AND user_id = ?2',
  )
    .bind(id, user.id)
    .first<BillRow>()

  return c.json({ data: bill }, 201)
})

app.get('/billing/tnb-domestic-am/bills', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const limit = parseLimit(c.req.query('limit'))
  const result = await c.env.DB.prepare(
    'SELECT id, user_id, system_code, period_start, period_end, peak_kwh, off_peak_kwh, total_kwh, tariff_type, tariff_effective_date, energy_charge, afa, capacity_charge, network_charge, retail_charge, efficiency_incentive, subtotal, taxable_subtotal, service_tax, kwtbb, total_amount, currency, created_at, updated_at FROM bills WHERE user_id = ?1 AND system_code = ?2 ORDER BY created_at DESC LIMIT ?3',
  )
    .bind(user.id, 'TNB_DOMESTIC_AM', limit)
    .all<BillRow>()

  return c.json({ data: result.results })
})

app.get('/notes', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const limit = parseLimit(c.req.query('limit'))

  const result = await c.env.DB.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes ORDER BY created_at DESC LIMIT ?1',
  )
    .bind(limit)
    .all<NoteRow>()

  return c.json({ data: result.results })
})

app.get('/notes/:id', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ?1',
  )
    .bind(id)
    .first<NoteRow>()

  if (!row) return c.json({ error: 'Not Found' }, 404)
  return c.json({ data: row })
})

app.post('/notes', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json().catch(() => ({}))

  let title: string
  let content: string
  try {
    title = assertString((body as Record<string, unknown>).title, 'title')
    content = assertString((body as Record<string, unknown>).content, 'content')
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      400,
    )
  }

  const id = crypto.randomUUID()

  await c.env.DB.prepare(
    "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?1, ?2, ?3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  )
    .bind(id, title, content)
    .run()

  const created = await c.env.DB.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ?1',
  )
    .bind(id)
    .first<NoteRow>()

  return c.json({ data: created }, 201)
})

app.put('/notes/:id', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const titleRaw = (body as Record<string, unknown>).title
  const contentRaw = (body as Record<string, unknown>).content

  const hasTitle = titleRaw !== undefined
  const hasContent = contentRaw !== undefined
  if (!hasTitle && !hasContent) return c.json({ error: 'Nothing to update' }, 400)

  let title: string | undefined
  let content: string | undefined
  try {
    if (hasTitle) title = assertString(titleRaw, 'title')
    if (hasContent) content = assertString(contentRaw, 'content')
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      400,
    )
  }

  const existing = await c.env.DB.prepare('SELECT id FROM notes WHERE id = ?1')
    .bind(id)
    .first<{ id: string }>()

  if (!existing) return c.json({ error: 'Not Found' }, 404)

  await c.env.DB.prepare(
    'UPDATE notes SET title = COALESCE(?2, title), content = COALESCE(?3, content), updated_at = CURRENT_TIMESTAMP WHERE id = ?1',
  )
    .bind(id, title ?? null, content ?? null)
    .run()

  const updated = await c.env.DB.prepare(
    'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = ?1',
  )
    .bind(id)
    .first<NoteRow>()

  return c.json({ data: updated })
})

app.delete('/notes/:id', async (c) => {
  if (!c.env.AUTH_SECRET) return c.json({ error: 'Server misconfigured' }, 500)

  let user: SessionUser
  try {
    user = await requireUser(c.env, c.req.header('authorization'))
  } catch {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const id = c.req.param('id')
  const result = await c.env.DB.prepare('DELETE FROM notes WHERE id = ?1').bind(id).run()
  if (result.meta.changes === 0) return c.json({ error: 'Not Found' }, 404)
  return c.body(null, 204)
})

app.notFound((c) => c.json({ error: 'Not Found' }, 404))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

export default app
