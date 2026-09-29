import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { resolveSessionKey } from './messages.js'

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}

describe('resolveSessionKey', () => {
  it('keeps an explicit proxy session header as the highest priority', () => {
    expect(
      resolveSessionKey(request({ 'x-dust-session': 'dust-session', 'x-opencode-session': 'oc-session' }), {} as never),
    ).toBe('dust-session')
  })

  it('isolates OpenCode 2 conversations with x-opencode-session', () => {
    expect(resolveSessionKey(request({ 'x-opencode-session': 'ses_123' }), {} as never)).toBe(
      'opencode:ses_123',
    )
  })

  it('falls back to metadata user_id and then the API key', () => {
    expect(resolveSessionKey(request({}), { metadata: { user_id: 'user-1' } } as never)).toBe(
      'meta:user-1',
    )
    expect(resolveSessionKey(request({ 'x-api-key': 'proxy-key' }), {} as never)).toBe(
      'key:proxy-key',
    )
  })
})
