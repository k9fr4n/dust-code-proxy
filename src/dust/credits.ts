import { z } from 'zod'
import { ProxyError } from '../errors.js'

// Credit balance reporting.
//
// The public Dust API (v1) documents credit *consumption*
// (`POST /api/v1/w/{wId}/analytics/consumption/export`, admin-only) but no
// "remaining credits" endpoint. The web app reads the balance from
// `GET /api/w/{wId}/fair-use-credits`: undocumented, but it accepts the same
// WorkOS bearer token as the public API and needs no admin role.
//
// Observed payload (eu.dust.tt):
//
//   { "fairUseAwuCreditsState": {
//       "limit": 20000, "count": 17342, "timeframe": "week",
//       "windowKind": "rolling", "nextResetAt": "2026-09-23T19:23:03.021Z",
//       "refillSchedule": [ { "date": "2026-09-23", "credits": 190 }, … ] } }
//
// `count` is the amount *used* inside the window, so the balance is
// `limit - count`. With a rolling window nothing is granted at a fixed date:
// credits come back as old spend ages out, which is what `refillSchedule`
// describes (`nextResetAt` is only the closest of those refills).

export const CREDITS_PATH = '/api/w/{ws}/fair-use-credits'

export interface CreditRefill {
  date: string
  credits: number
}

export interface CreditsInfo {
  source: string
  limit: number
  used: number
  remaining: number
  timeframe?: string
  windowKind?: string
  nextResetAt?: string
  refillSchedule: CreditRefill[]
}

// Only `limit` and `count` are required: the rest is display sugar and must not
// make the command fail if Dust renames or drops it.
const stateSchema = z.object({
  limit: z.number(),
  count: z.number(),
  timeframe: z.string().nullish(),
  windowKind: z.string().nullish(),
  nextResetAt: z.union([z.string(), z.number()]).nullish(),
  refillSchedule: z
    .array(z.object({ date: z.string(), credits: z.number() }))
    .nullish(),
})

const responseSchema = z.object({ fairUseAwuCreditsState: stateSchema })

function toIsoDate(value: string | number): string {
  if (typeof value === 'number') return new Date(value).toISOString()
  return value
}

export function parseCredits(json: unknown, source: string): CreditsInfo {
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProxyError(
      'api_error',
      `Unexpected credit payload from Dust (${source}): ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      502,
    )
  }
  const state = parsed.data.fairUseAwuCreditsState
  return {
    source,
    limit: state.limit,
    used: state.count,
    remaining: state.limit - state.count,
    timeframe: state.timeframe ?? undefined,
    windowKind: state.windowKind ?? undefined,
    nextResetAt:
      state.nextResetAt === null || state.nextResetAt === undefined
        ? undefined
        : toIsoDate(state.nextResetAt),
    refillSchedule: state.refillSchedule ?? [],
  }
}
