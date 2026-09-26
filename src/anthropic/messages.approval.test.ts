import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config.js'
import { ServerContext } from '../context.js'
import { DustClient } from '../dust/client.js'
import { ModelRouter } from '../models.js'
import { SessionStore } from '../sessions.js'
import { buildServer } from '../server.js'

// Dust parks a generation on a `tool_approve_execution` event until someone answers
// it, and the proxy can only answer while it is reading the message-events stream.
// Answering `always_approved` makes Dust remember the choice and stop asking for
// that tool, which removes the window where a validation can arrive with nobody
// listening (the generation then waits forever, with Dust showing
// "Allow <agent> to use <server>?").
//
// Verified live against the Dust API:
//   approved       -> one validation event per tool call (2 calls, 2 approvals)
//   always_approved -> validation on the first call only (2 calls, 1 approval), and
//                      Dust keeps that choice across sessions and conversations.

const API_KEY = 'k'
const SESSION = 'sess-approval'

function setup(env: NodeJS.ProcessEnv = {}): {
  ctx: ServerContext
  validations: { actionId: string; approved: string }[]
  declaredServerIds: (string[] | undefined)[]
} {
  const validations: { actionId: string; approved: string }[] = []
  const declaredServerIds: (string[] | undefined)[] = []
  const dust = {
    get isAuthenticated() {
      return true
    },
    workspaceId: () => 'w-123',
    registerMcpServer: async () => ({
      serverId: 'srv_1',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }),
    heartbeatMcpServer: async () => ({
      success: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    }),
    streamMcpRequests: () =>
      (async function* () {
        await new Promise<void>(() => {})
      })(),
    createConversation: async (
      _title: string,
      opts: { clientSideMCPServerIds?: string[] },
    ) => {
      declaredServerIds.push(opts.clientSideMCPServerIds)
      return { conversationId: 'conv_1', agentMessageId: 'amsg_1' }
    },
    validateAction: async (
      _conversationId: string,
      _messageId: string,
      actionId: string,
      approved: string,
    ) => {
      validations.push({ actionId, approved })
    },
    streamMessageEvents: () =>
      (async function* () {
        yield {
          kind: 'event' as const,
          eventId: 'e1',
          type: 'tool_approve_execution',
          data: { type: 'tool_approve_execution', actionId: 'act_1', messageId: 'amsg_1' },
        }
        yield {
          kind: 'event' as const,
          eventId: 'e2',
          type: 'agent_message_success',
          data: { type: 'agent_message_success', message: { content: 'done' } },
        }
        yield { kind: 'done' as const }
      })(),
  } as unknown as DustClient

  const config = loadConfig({
    INTERNAL_TOKEN: 't',
    PROXY_API_KEYS: API_KEY,
    LOG_LEVEL: 'silent',
    MODELS_FILE: '/nonexistent-models.json',
    ...env,
  } as NodeJS.ProcessEnv)

  return {
    ctx: {
      config: { ...config, dustDefaultAgentConfigurationId: 'Dev' },
      dust,
      router: new ModelRouter({ 'claude-sonnet-4-5': { configurationId: 'agent-1' } }),
      sessions: new SessionStore(),
    },
    validations,
    declaredServerIds,
  }
}

const TOOL = {
  name: 'bash',
  description: 'run a command',
  input_schema: { type: 'object' as const, properties: { command: { type: 'string' } } },
}

async function turn(
  ctx: ServerContext,
  stream: boolean,
  tools?: unknown[],
): Promise<string> {
  const app = buildServer(ctx)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-api-key': API_KEY, 'x-dust-session': SESSION },
    payload: {
      model: 'claude-sonnet-4-5',
      stream,
      max_tokens: 128,
      ...(tools ? { tools } : {}),
      messages: [{ role: 'user', content: 'run the tool' }],
    },
  })
  await app.close()
  return res.payload
}

describe('client-side tool validation', () => {
  it('answers always_approved by default, so Dust stops asking', async () => {
    const { ctx, validations } = setup()
    const payload = await turn(ctx, true)
    expect(validations).toEqual([{ actionId: 'act_1', approved: 'always_approved' }])
    expect(payload).toContain('done')
  })

  it('answers always_approved on the non-streaming path too', async () => {
    const { ctx, validations } = setup()
    await turn(ctx, false)
    expect(validations).toEqual([{ actionId: 'act_1', approved: 'always_approved' }])
  })

  it('can be reverted to per-call approval with DUST_TOOL_APPROVAL=approved', async () => {
    const { ctx, validations } = setup({ DUST_TOOL_APPROVAL: 'approved' })
    await turn(ctx, true)
    expect(validations).toEqual([{ actionId: 'act_1', approved: 'approved' }])
  })
})

describe('loadConfig: DUST_TOOL_APPROVAL', () => {
  const base = {
    INTERNAL_TOKEN: 't',
    PROXY_API_KEYS: 'k',
    MODELS_FILE: '/nonexistent-models.json',
  } as NodeJS.ProcessEnv

  it('defaults to always_approved', () => {
    expect(loadConfig(base).dustToolApproval).toBe('always_approved')
  })

  it('accepts approved', () => {
    expect(loadConfig({ ...base, DUST_TOOL_APPROVAL: 'approved' }).dustToolApproval).toBe(
      'approved',
    )
  })

  it('falls back to always_approved on an unknown value', () => {
    expect(loadConfig({ ...base, DUST_TOOL_APPROVAL: 'nope' }).dustToolApproval).toBe(
      'always_approved',
    )
  })
})

// A non-streaming request used to take a separate, simplified path: it never
// registered the client-side MCP server, so the tools were silently dropped (the
// Dust agent answered "I don't have that tool"), and it ignored validation
// requests, so any tool call hung until the idle timeout.
describe('non-streaming requests carrying tools', () => {
  it('declares the client-side MCP server to Dust, like the streaming path', async () => {
    const { ctx, declaredServerIds } = setup()
    await turn(ctx, false, [TOOL])
    expect(declaredServerIds).toEqual([['srv_1']])
  })

  it('declares no server when the request carries no tools', async () => {
    const { ctx, declaredServerIds } = setup()
    await turn(ctx, false)
    expect(declaredServerIds).toEqual([[]])
  })

  it('approves validation requests on that path', async () => {
    const { ctx, validations } = setup()
    await turn(ctx, false, [TOOL])
    expect(validations).toEqual([{ actionId: 'act_1', approved: 'always_approved' }])
  })
})
