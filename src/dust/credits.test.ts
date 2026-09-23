import { describe, expect, it } from 'vitest'
import { parseCredits } from './credits.js'
import { ProxyError } from '../errors.js'

// Payload captured from GET /api/w/{wId}/fair-use-credits on eu.dust.tt.
const payload = {
  fairUseAwuCreditsState: {
    limit: 20000,
    timeframe: 'week',
    count: 17342,
    nextResetAt: '2026-09-23T19:23:03.021Z',
    refillSchedule: [
      { date: '2026-09-23', credits: 190 },
      { date: '2026-09-24', credits: 9341 },
    ],
    windowKind: 'rolling',
  },
}

describe('parseCredits', () => {
  it('derives the balance from limit and count', () => {
    const info = parseCredits(payload, 'test')
    expect(info).toMatchObject({
      limit: 20000,
      used: 17342,
      remaining: 2658,
      timeframe: 'week',
      windowKind: 'rolling',
      nextResetAt: '2026-09-23T19:23:03.021Z',
    })
    expect(info.refillSchedule).toHaveLength(2)
  })

  it('tolerates a payload without the display fields', () => {
    const info = parseCredits(
      { fairUseAwuCreditsState: { limit: 500, count: 500 } },
      'test',
    )
    expect(info.remaining).toBe(0)
    expect(info.timeframe).toBeUndefined()
    expect(info.refillSchedule).toEqual([])
  })

  it('normalises an epoch nextResetAt', () => {
    const info = parseCredits(
      { fairUseAwuCreditsState: { limit: 10, count: 1, nextResetAt: 0 } },
      'test',
    )
    expect(info.nextResetAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('rejects a payload without the credit figures', () => {
    expect(() => parseCredits({ foo: 1 }, 'test')).toThrow(ProxyError)
  })
})
