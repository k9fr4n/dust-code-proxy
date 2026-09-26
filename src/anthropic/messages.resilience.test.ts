import { describe, it, expect } from 'vitest'
import { streamMessageEventsResilient } from './messages.js'
import type { ServerContext } from '../context.js'
import { ProxyError } from '../errors.js'
import { IDLE_STREAM_ERROR_MARKER } from '../dust/stream-errors.js'

// Each "attempt" is one call to `DustClient.streamMessageEvents`; a test describes
// the stream as a list of attempts, so resumes are directly observable.
type Attempt = () => AsyncGenerator<any>

function ctxWith(attempts: Attempt[]): {
  ctx: ServerContext
  calls: { lastEventId?: string }[]
} {
  const calls: { lastEventId?: string }[] = []
  let i = 0
  const ctx = {
    dust: {
      streamMessageEvents: (
        _conversationId: string,
        _agentMessageId: string,
        opts?: { lastEventId?: string },
      ) => {
        calls.push({ lastEventId: opts?.lastEventId })
        const attempt = attempts[Math.min(i, attempts.length - 1)]
        i += 1
        return attempt()
      },
    },
  } as unknown as ServerContext
  return { ctx, calls }
}

function event(eventId: string, type = 'generation_tokens') {
  return { kind: 'event' as const, eventId, type, data: { type, text: eventId } }
}

const idleTimeout = () =>
  new ProxyError('api_error', `${IDLE_STREAM_ERROR_MARKER} for 120000ms; stream aborted.`, 504)

async function drain(
  ctx: ServerContext,
  signal?: AbortSignal,
  cursor?: string,
): Promise<{ ids: string[]; cursors: string[] }> {
  const ids: string[] = []
  const cursors: string[] = []
  for await (const e of streamMessageEventsResilient(
    ctx,
    'conv',
    'msg',
    signal,
    cursor,
    (id) => cursors.push(id),
  )) {
    ids.push(e.eventId)
  }
  return { ids, cursors }
}

describe('streamMessageEventsResilient', () => {
  it('yields events and stops on the done sentinel', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
        yield event('2')
        yield { kind: 'done' as const }
      },
    ])
    const { ids, cursors } = await drain(ctx)
    expect(ids).toEqual(['1', '2'])
    expect(cursors).toEqual(['1', '2'])
    expect(calls).toHaveLength(1)
  })

  it('resumes a premature clean EOF (no done sentinel) from the last event id', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
      },
      async function* () {
        yield event('2')
        yield { kind: 'done' as const }
      },
    ])
    const { ids } = await drain(ctx)
    expect(ids).toEqual(['1', '2'])
    expect(calls.map((c) => c.lastEventId)).toEqual([undefined, '1'])
  })

  it('resumes a transient upstream drop from the last event id', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
        throw new Error('terminated: other side closed')
      },
      async function* () {
        yield event('2')
        yield { kind: 'done' as const }
      },
    ])
    const { ids } = await drain(ctx)
    expect(ids).toEqual(['1', '2'])
    expect(calls.map((c) => c.lastEventId)).toEqual([undefined, '1'])
  })

  it('fails fast on the idle timeout instead of resuming (issue #35)', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
        throw idleTimeout()
      },
    ])
    await expect(drain(ctx)).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining(IDLE_STREAM_ERROR_MARKER),
    })
    // No re-subscription: the stalled generation is surfaced immediately.
    expect(calls).toHaveLength(1)
  })

  it('gives up when resumes stop producing new events', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        throw new Error('terminated: other side closed')
      },
    ])
    await expect(drain(ctx, undefined, 'cursor-0')).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining('no new event'),
    })
    expect(calls).toHaveLength(2)
  })

  it('re-throws a caller-driven abort without resuming', async () => {
    const ac = new AbortController()
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
        ac.abort()
        const err = new Error('This operation was aborted')
        err.name = 'AbortError'
        throw err
      },
    ])
    await expect(drain(ctx, ac.signal)).rejects.toThrow('aborted')
    expect(calls).toHaveLength(1)
  })

  it('re-throws a non-transient error without resuming', async () => {
    const { ctx, calls } = ctxWith([
      async function* () {
        yield event('1')
        throw new ProxyError('api_error', 'Dust SSE stream failed (500)', 502)
      },
    ])
    await expect(drain(ctx)).rejects.toThrow('Dust SSE stream failed')
    expect(calls).toHaveLength(1)
  })

  it('gives up after the resume budget even when each resume makes progress', async () => {
    let n = 0
    const { ctx, calls } = ctxWith([
      async function* () {
        n += 1
        yield event(`e${n}`)
        throw new Error('terminated: other side closed')
      },
    ])
    await expect(drain(ctx)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('dropped 4 times'),
    })
    expect(calls).toHaveLength(4)
  })

  it('never re-delivers the event it resumed from, even if lastEventId were inclusive', async () => {
    const { ctx } = ctxWith([
      async function* () {
        yield event('1')
        throw new Error('terminated: other side closed')
      },
      async function* () {
        yield event('1') // inclusive-cursor replay
        yield event('2')
        yield { kind: 'done' as const }
      },
    ])
    const { ids } = await drain(ctx)
    expect(ids).toEqual(['1', '2'])
  })

  it('skips non-event frames', async () => {
    const { ctx } = ctxWith([
      async function* () {
        yield { kind: 'unknown' as const, raw: 'noise' }
        yield event('1')
        yield { kind: 'done' as const }
      },
    ])
    const { ids } = await drain(ctx)
    expect(ids).toEqual(['1'])
  })
})
