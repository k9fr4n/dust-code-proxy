// Credit balance reporting.
//
// [hypothèse] The public Dust API (v1) documents credit *consumption*
// (`POST /api/v1/w/{wId}/analytics/consumption/export`) but no "remaining
// credits" endpoint. So the lookup is two-tiered:
//
//   1. probe a short list of candidate balance endpoints and parse whatever
//      shape comes back (they exist for the web app, are undocumented, and may
//      404 or 403 depending on region/plan/role);
//   2. fall back to the documented consumption export over the current billing
//      period to report credits *used*, and derive what is left when the
//      allowance is known (`DUST_CREDIT_ALLOWANCE`).
//
// Every field is optional: a caller must render "unknown" rather than 0.

export interface CreditsInfo {
  source: string
  plan?: string
  allowance?: number
  used?: number
  remaining?: number
  periodStart?: string
  periodEnd?: string
}

const ALLOWANCE_KEYS = [
  'creditsAllowance',
  'creditsIncluded',
  'creditsGranted',
  'creditsTotal',
  'totalCredits',
  'allowance',
  'included',
  'quota',
  'limit',
]

const USED_KEYS = [
  'creditsUsed',
  'creditsConsumed',
  'creditsSpent',
  'usedCredits',
  'consumedCredits',
  'used',
  'consumed',
  'consumption',
]

const REMAINING_KEYS = [
  'creditsRemaining',
  'creditsLeft',
  'creditsBalance',
  'remainingCredits',
  'balance',
  'remaining',
  'left',
]

const PLAN_KEYS = ['planCode', 'planName', 'plan', 'code', 'name', 'tier']
const PERIOD_START_KEYS = ['startDate', 'periodStart', 'currentPeriodStart', 'start']
const PERIOD_END_KEYS = ['endDate', 'periodEnd', 'currentPeriodEnd', 'end']

// Breadth-first walk over the response body: the value we want is sometimes at
// the root, sometimes under `subscription`, `plan`, `credits` or `workspace`.
function findValue(
  json: unknown,
  keys: string[],
  accept: (value: unknown) => boolean,
): unknown {
  const queue: unknown[] = [json]
  const seen = new Set<unknown>()
  const wanted = new Set(keys.map((k) => k.toLowerCase()))
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase()) && accept(value)) return value
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return undefined
}

const isFiniteNumber = (value: unknown): boolean =>
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))

function findNumber(json: unknown, keys: string[]): number | undefined {
  const value = findValue(json, keys, isFiniteNumber)
  return value === undefined ? undefined : Number(value)
}

function findString(json: unknown, keys: string[]): string | undefined {
  const value = findValue(json, keys, (v) => typeof v === 'string' && v !== '')
  return value === undefined ? undefined : String(value)
}

export function parseCredits(json: unknown, source: string): CreditsInfo {
  const allowance = findNumber(json, ALLOWANCE_KEYS)
  const used = findNumber(json, USED_KEYS)
  const explicitRemaining = findNumber(json, REMAINING_KEYS)
  const remaining =
    explicitRemaining ??
    (allowance !== undefined && used !== undefined ? allowance - used : undefined)
  return {
    source,
    plan: findString(json, PLAN_KEYS),
    allowance,
    used,
    remaining,
    periodStart: findString(json, PERIOD_START_KEYS),
    periodEnd: findString(json, PERIOD_END_KEYS),
  }
}

export function hasCreditFigures(info: CreditsInfo): boolean {
  return (
    info.allowance !== undefined ||
    info.used !== undefined ||
    info.remaining !== undefined
  )
}

// Candidate "balance" endpoints, most specific first. `{ws}` is substituted with
// the workspace sId.
export const CREDIT_BALANCE_PATHS = [
  '/api/v1/w/{ws}/credits',
  '/api/v1/w/{ws}/subscriptions',
  '/api/w/{ws}/credits',
  '/api/w/{ws}/subscriptions',
  '/api/w/{ws}/usage/credits',
]

// Current UTC calendar month, used as the billing period for the consumption
// fallback. [hypothèse] Dust bills credits per calendar month.
export function currentPeriod(now: Date = new Date()): {
  startDate: string
  endDate: string
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { startDate: start.toISOString(), endDate: now.toISOString() }
}

// The consumption export streams one row per billed call, as CSV or JSON. Sum
// the credit column whatever it is called.
export function sumConsumption(body: string): number | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return sumConsumptionJson(trimmed)
  }
  return sumConsumptionCsv(trimmed)
}

function sumConsumptionJson(body: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>)?.rows ??
       (parsed as Record<string, unknown>)?.data ??
       [])
  if (!Array.isArray(rows)) return undefined
  let total = 0
  let seen = false
  for (const row of rows) {
    const value = findNumber(row, ['credits', 'credit', 'creditCost', 'cost'])
    if (value !== undefined) {
      total += value
      seen = true
    }
  }
  return seen ? total : undefined
}

function sumConsumptionCsv(body: string): number | undefined {
  const lines = body.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return undefined
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase())
  const index = header.findIndex((h) => h === 'credits' || h === 'credit' || h === 'credit_cost')
  if (index < 0) return undefined
  let total = 0
  let seen = false
  for (const line of lines.slice(1)) {
    const raw = line.split(',')[index]?.trim().replace(/^"|"$/g, '')
    if (raw && Number.isFinite(Number(raw))) {
      total += Number(raw)
      seen = true
    }
  }
  return seen ? total : undefined
}
