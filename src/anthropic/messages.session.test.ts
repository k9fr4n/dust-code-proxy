import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { isNamingRequest, resolveSessionKey } from './messages.js'
import { acquireSessionTurn, type Session } from '../sessions.js'

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

describe('isNamingRequest', () => {
  it('detects the Claude Code session-naming request', () => {
    expect(isNamingRequest({ system: 'You are naming a coding session.' } as never)).toBe(true)
  })

  // OpenCode 2 fires this one on the same x-opencode-session, milliseconds before
  // the real turn. Treated as a normal turn it opened a second Dust conversation
  // with the same title and hijacked the real turn's agent message.
  it('detects the OpenCode title-generator request', () => {
    const system = [
      { type: 'text', text: 'You are a title generator. You output ONLY a thread title.' },
    ]
    expect(isNamingRequest({ system } as never)).toBe(true)
  })

  it('leaves a real turn alone', () => {
    expect(isNamingRequest({ system: 'You are an AI agent running in OpenCode.' } as never)).toBe(
      false,
    )
    expect(isNamingRequest({} as never)).toBe(false)
  })
})

describe('acquireSessionTurn', () => {
  it('runs the turns of one session one at a time', async () => {
    const session = { lastActivityAt: Date.now() } as Session
    const order: string[] = []

    const firstRelease = await acquireSessionTurn(session)
    const second = acquireSessionTurn(session).then((release) => {
      order.push('second')
      release()
    })

    order.push('first')
    // The second turn must still be queued while the first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(['first'])

    firstRelease()
    await second
    expect(order).toEqual(['first', 'second'])
  })

  it('ignores a double release and keeps handing the lock over', async () => {
    const session = { lastActivityAt: Date.now() } as Session
    const release = await acquireSessionTurn(session)
    release()
    release()
    const next = await acquireSessionTurn(session)
    expect(typeof next).toBe('function')
    next()
  })
})
