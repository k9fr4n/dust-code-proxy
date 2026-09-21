import { describe, it, expect } from 'vitest'
import { parseDustData, parseSseBlock } from './sse.js'

describe('parseDustData', () => {
  it('parses a Dust event envelope', () => {
    const event = parseDustData(
      '{"eventId":"123","data":{"type":"generation_tokens","text":"Hello"}}',
    )
    expect(event).toEqual({
      kind: 'event',
      eventId: '123',
      type: 'generation_tokens',
      data: { type: 'generation_tokens', text: 'Hello' },
    })
  })

  it('recognizes the done sentinel', () => {
    expect(parseDustData('done')).toEqual({ kind: 'done' })
  })

  it('handles malformed data', () => {
    expect(parseDustData('not json')).toEqual({ kind: 'unknown', raw: 'not json' })
  })

  it('returns null for empty data', () => {
    expect(parseDustData('')).toBeNull()
  })
})

describe('parseSseBlock', () => {
  it('parses a standard SSE block', () => {
    const event = parseSseBlock(
      'event: message\ndata: {"eventId":"1","data":{"type":"generation_tokens","text":"hi"}}',
    )
    expect(event?.kind).toBe('event')
    if (event?.kind === 'event') expect(event.type).toBe('generation_tokens')
  })

  it('ignores comment-only blocks (keep-alive)', () => {
    expect(parseSseBlock(': keep-alive')).toBeNull()
  })

  it('parses the done sentinel through an SSE block', () => {
    expect(parseSseBlock('data: done')).toEqual({ kind: 'done' })
  })

  it('handles CRLF line endings', () => {
    const event = parseSseBlock(
      'event: message\r\ndata: {"eventId":"1","data":{"type":"agent_error","message":"boom"}}',
    )
    expect(event?.kind).toBe('event')
    if (event?.kind === 'event') expect(event.type).toBe('agent_error')
  })
})
