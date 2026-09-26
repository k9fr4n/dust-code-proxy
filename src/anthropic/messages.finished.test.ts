import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { ServerContext } from '../context.js'
import { DustClient } from '../dust/client.js'
import { ModelRouter } from '../models.js'
import { SessionStore } from '../sessions.js'
import { buildServer } from '../server.js'
import { NO_VISIBLE_ANSWER_TEXT } from './stream.js'
import { ProxyError } from '../errors.js'
import { IDLE_STREAM_ERROR_MARKER } from '../dust/stream-errors.js'

// A tool-result turn whose Dust generation already finished must be answered from
// the stored message. Resuming its events stream is a dead end: Dust keeps it open
// and silent, so the turn used to burn `idleStreamMs` (120 s in production) and
// fail with 504 — which Claude Code retried forever while Dust was done.

const API_KEY = 'k'
const SESSION = 'sess-1'
const CONVERSATION = 'conv_1'
const AGENT_MESSAGE = 'amsg_1'

interface MessageState {
  status?: string
  content?: string
  chainOfThought?: string
  error?: string
}

interface Fake {
  states: (MessageState | null)[]
  stateCalls: number
  streamCalls: number
  resolved: string[]
}

// `state` may be a list: one entry per `getAgentMessageState` call (the last one
// repeats), so a test can have the message finish *between* the pre-check and the
// resume. `streamError` makes the resumed stream fail the way Dust's silent stream
// does in production (our idle timeout).
function buildContext(
  state: MessageState | null | (MessageState | null)[],
  streamError?: unknown,
): { ctx: ServerContext; fake: Fake } {
  const fake: Fake = {
    states: Array.isArray(state) ? state : [state],
    stateCalls: 0,
    streamCalls: 0,
    resolved: [],
  }
  const dust = {
    get isAuthenticated() {
      return true
    },
    workspaceId: () => 'w-123',
    getAgentMessageState: async (conversationId: string, agentMessageId: string) => {
      fake.stateCalls += 1
      expect(conversationId).toBe(CONVERSATION)
      expect(agentMessageId).toBe(AGENT_MESSAGE)
      const current =
        fake.states[Math.min(fake.stateCalls - 1, fake.states.length - 1)] ?? null
      return current ? { sId: agentMessageId, ...current } : undefined
    },
    // Mimics Dust on a resumed, already-finished message: open and silent forever
    // (or failing with our idle timeout when the test asks for it).
    streamMessageEvents: () => {
      fake.streamCalls += 1
      return (async function* () {
        if (streamError) throw streamError
        await new Promise<void>(() => {})
      })()
    },
  } as unknown as DustClient

  const config = loadConfig({
    INTERNAL_TOKEN: 't',
    PROXY_API_KEYS: API_KEY,
    LOG_LEVEL: 'silent',
    MODELS_FILE: '/nonexistent-models.json',
  } as NodeJS.ProcessEnv)

  const sessions = new SessionStore()
  const session = sessions.create(SESSION, API_KEY, 'w-123')
  session.conversationId = CONVERSATION
  session.agentMessageId = AGENT_MESSAGE
  session.lastEventId = '1790413890071-0'
  session.mcp = {
    resolveToolResult: async (toolUseId: string) => {
      fake.resolved.push(toolUseId)
      return { status: 'unknown' as const }
    },
    setEmitter: () => {},
    close: async () => {},
  } as unknown as typeof session.mcp

  return {
    ctx: {
      config: { ...config, dustDefaultAgentConfigurationId: 'Dev' },
      dust,
      router: new ModelRouter({ 'claude-sonnet-4-5': { configurationId: 'agent-1' } }),
      sessions,
    },
    fake,
  }
}

function toolResultRequest(stream: boolean): Record<string, unknown> {
  return {
    model: 'claude-sonnet-4-5',
    stream,
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'list the files' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }],
      },
    ],
  }
}

async function post(
  ctx: ServerContext,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; payload: string }> {
  const app = buildServer(ctx)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-api-key': API_KEY, 'x-dust-session': SESSION },
    payload: body,
  })
  await app.close()
  return { statusCode: res.statusCode, payload: res.payload }
}

describe('tool-result turn on an already-finished Dust message', () => {
  it('answers from the stored message instead of resuming (non-streaming)', async () => {
    const { ctx, fake } = buildContext({ status: 'succeeded', content: 'All done.' })
    const res = await post(ctx, toolResultRequest(false))
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)
    expect(json.content).toEqual([{ type: 'text', text: 'All done.' }])
    expect(json.stop_reason).toBe('end_turn')
    // The dead events stream is never opened.
    expect(fake.streamCalls).toBe(0)
    expect(fake.stateCalls).toBe(1)
    // The tool result is still delivered to Dust first.
    expect(fake.resolved).toEqual(['toolu_1'])
    // And the resume cursor is cleared so the next turn cannot resume a dead stream.
    expect(ctx.sessions.get(SESSION)?.lastEventId).toBeUndefined()
  })

  it('answers from the stored message instead of resuming (streaming)', async () => {
    const { ctx, fake } = buildContext({ status: 'succeeded', content: 'All done.' })
    const res = await post(ctx, toolResultRequest(true))
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('message_start')
    expect(res.payload).toContain('All done.')
    expect(res.payload).toContain('message_stop')
    expect(fake.streamCalls).toBe(0)
  })

  it('falls back to the reasoning when the agent left no visible answer', async () => {
    // The exact production case: status succeeded, content "", 4 tool actions.
    const { ctx } = buildContext({
      status: 'succeeded',
      content: '',
      chainOfThought: 'I inspected the diff and the package.json.',
    })
    const res = await post(ctx, toolResultRequest(false))
    const json = JSON.parse(res.payload)
    expect(json.content[0].text).toBe('I inspected the diff and the package.json.')
  })

  it('always produces visible content, even with no answer and no reasoning', async () => {
    const { ctx } = buildContext({ status: 'succeeded', content: '' })
    const res = await post(ctx, toolResultRequest(false))
    const json = JSON.parse(res.payload)
    expect(json.content[0].text).toBe(NO_VISIBLE_ANSWER_TEXT)
  })

  it('surfaces a failed Dust message as an error', async () => {
    const { ctx } = buildContext({ status: 'failed', error: 'model overloaded' })
    const res = await post(ctx, toolResultRequest(false))
    expect(res.statusCode).toBe(502)
    expect(res.payload).toContain('model overloaded')
  })

  it('resumes normally while the generation is still running', async () => {
    const { ctx, fake } = buildContext({ status: 'created' })
    const app = buildServer(ctx)
    const pending = app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': API_KEY, 'x-dust-session': SESSION },
      payload: toolResultRequest(false),
    })
    await vi.waitFor(() => expect(fake.streamCalls).toBe(1))
    expect(fake.stateCalls).toBe(1)
    void pending.catch(() => {})
    await app.close()
  })

  it('resumes normally when the message state cannot be read', async () => {
    const { ctx, fake } = buildContext(null)
    const app = buildServer(ctx)
    const pending = app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-api-key': API_KEY, 'x-dust-session': SESSION },
      payload: toolResultRequest(false),
    })
    await vi.waitFor(() => expect(fake.streamCalls).toBe(1))
    void pending.catch(() => {})
    await app.close()
  })
})

// The message can also finish *between* the pre-check and the resume. The resumed
// stream then goes silent and our idle timeout fires: rather than pushing a 504 to
// Claude Code, the turn is settled from the stored message.
describe('idle timeout on a resume whose message finished meanwhile', () => {
  const idleError = new ProxyError(
    'api_error',
    `${IDLE_STREAM_ERROR_MARKER} for 120000ms; stream aborted.`,
    504,
  )

  it('settles the turn from the stored message (non-streaming)', async () => {
    const { ctx, fake } = buildContext(
      [{ status: 'created' }, { status: 'succeeded', content: 'Finished late.' }],
      idleError,
    )
    const res = await post(ctx, toolResultRequest(false))
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.payload)
    expect(json.content).toEqual([{ type: 'text', text: 'Finished late.' }])
    expect(fake.streamCalls).toBe(1)
    expect(fake.stateCalls).toBe(2)
    expect(ctx.sessions.get(SESSION)?.lastEventId).toBeUndefined()
  })

  it('settles the turn from the stored message (streaming)', async () => {
    const { ctx, fake } = buildContext(
      [{ status: 'created' }, { status: 'succeeded', content: 'Finished late.' }],
      idleError,
    )
    const res = await post(ctx, toolResultRequest(true))
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('Finished late.')
    expect(res.payload).toContain('message_stop')
    expect(res.payload).not.toContain('"type":"error"')
    expect(fake.streamCalls).toBe(1)
  })

  it('still errors when the message is genuinely stuck (status created)', async () => {
    const { ctx } = buildContext([{ status: 'created' }, { status: 'created' }], idleError)
    const res = await post(ctx, toolResultRequest(false))
    expect(res.statusCode).toBe(504)
    expect(res.payload).toContain(IDLE_STREAM_ERROR_MARKER)
  })
})
