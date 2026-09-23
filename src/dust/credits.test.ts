import { describe, expect, it } from 'vitest'
import {
  currentPeriod,
  hasCreditFigures,
  parseCredits,
  sumConsumption,
} from './credits.js'

describe('parseCredits', () => {
  it('reads a flat balance shape', () => {
    const info = parseCredits(
      { creditsAllowance: 8000, creditsUsed: 1200, planCode: 'PRO' },
      'test',
    )
    expect(info.allowance).toBe(8000)
    expect(info.used).toBe(1200)
    expect(info.remaining).toBe(6800)
    expect(info.plan).toBe('PRO')
  })

  it('prefers an explicit remaining over the derived one', () => {
    const info = parseCredits(
      { creditsAllowance: 8000, creditsUsed: 1200, creditsRemaining: 42 },
      'test',
    )
    expect(info.remaining).toBe(42)
  })

  it('finds figures nested under subscription/plan', () => {
    const info = parseCredits(
      {
        workspace: { sId: 'w1' },
        subscription: { plan: { name: 'Max', quota: 40000 }, consumed: 500 },
      },
      'test',
    )
    expect(info.allowance).toBe(40000)
    expect(info.used).toBe(500)
    expect(info.remaining).toBe(39500)
    expect(info.plan).toBe('Max')
  })

  it('accepts numeric strings', () => {
    expect(parseCredits({ balance: '123.5' }, 'test').remaining).toBe(123.5)
  })

  it('reports nothing usable for an unrelated payload', () => {
    const info = parseCredits({ error: { message: 'nope' } }, 'test')
    expect(hasCreditFigures(info)).toBe(false)
    expect(info.remaining).toBeUndefined()
  })
})

describe('sumConsumption', () => {
  it('sums a CSV credits column', () => {
    const csv = 'date,agent,credits\n2026-09-01,foo,1.5\n2026-09-02,bar,2.25\n'
    expect(sumConsumption(csv)).toBe(3.75)
  })

  it('ignores a CSV without a credits column', () => {
    expect(sumConsumption('date,agent\n2026-09-01,foo\n')).toBeUndefined()
  })

  it('sums a JSON array', () => {
    const json = JSON.stringify([{ credits: 2 }, { credits: 3 }, { other: 9 }])
    expect(sumConsumption(json)).toBe(5)
  })

  it('sums rows wrapped in an object', () => {
    const json = JSON.stringify({ rows: [{ creditCost: 1 }, { creditCost: 4 }] })
    expect(sumConsumption(json)).toBe(5)
  })

  it('returns undefined on an empty or unparsable body', () => {
    expect(sumConsumption('')).toBeUndefined()
    expect(sumConsumption('{not json')).toBeUndefined()
  })
})

describe('currentPeriod', () => {
  it('starts on the first day of the current UTC month', () => {
    const period = currentPeriod(new Date('2026-09-23T08:10:00Z'))
    expect(period.startDate).toBe('2026-09-01T00:00:00.000Z')
    expect(period.endDate).toBe('2026-09-23T08:10:00.000Z')
  })
})
