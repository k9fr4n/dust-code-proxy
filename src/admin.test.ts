import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { ServerContext } from './context.js'
import { DustClient } from './dust/client.js'
import { ModelRouter } from './models.js'
import { SessionStore } from './sessions.js'
import { buildServer } from './server.js'

const INTERNAL_TOKEN = 'test-internal-token'

interface FakeDust {
  creds: {
    workspaceSid: string
    region: string
    email?: string
    updatedAt: string
    tokenTtlSeconds: number
  } | null
  cleared: boolean
}

function buildContext(overrides: Partial<FakeDust> = {}): {
  ctx: ServerContext
  fake: FakeDust
} {
  const fake: FakeDust = {
    creds: {
      workspaceSid: 'w-123',
      region: 'europe-west1',
      email: 'dev@example.com',
      updatedAt: '2026-09-23T08:00:00.000Z',
      tokenTtlSeconds: 3600,
    },
    cleared: false,
    ...overrides,
  }

  const dust = {
    get isAuthenticated() {
      return fake.creds !== null
    },
    reload: async () => {},
    info: () => fake.creds,
    workspaceId: () => fake.creds?.workspaceSid ?? '',
    tokenTtlSeconds: () => fake.creds?.tokenTtlSeconds ?? 0,
    clearCredentials: async () => {
      fake.creds = null
      fake.cleared = true
    },
    listAgents: async () => [{ sId: 'agent-1', name: 'Dev' }],
    credits: async () => ({
      source: 'GET /api/w/w-123/fair-use-credits',
      limit: 20000,
      used: 17342,
      remaining: 2658,
      timeframe: 'week',
      windowKind: 'rolling',
      nextResetAt: '2026-09-23T19:23:03.021Z',
      refillSchedule: [{ date: '2026-09-23', credits: 190 }],
    }),
    modelCatalog: async () => ({
      source: 'GET /api/w/w-123/models',
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-opus-5',
          displayName: 'Claude Opus 5',
          contextSize: 250000,
          maxOutputTokens: 64000,
          isSelectable: true,
          supportsVision: true,
          reasoningEfforts: ['light', 'medium', 'high'],
          degraded: false,
        },
      ],
      defaultModel: undefined,
      streams: [{ stream: 'auto', providerId: 'openai', modelId: 'gpt-5.6-luna' }],
    }),
    agentList: async () => ({
      source: 'GET /api/w/w-123/assistant/agent_configurations?view=manage',
      agents: [
        {
          sId: 'agent-1',
          name: 'Dev',
          scope: 'hidden',
          status: 'active',
          userFavorite: false,
          canEdit: true,
          providerId: 'anthropic',
          modelId: 'claude-opus-5',
          actionCount: 0,
          tags: [],
        },
        {
          sId: 'agent-2',
          name: 'help',
          scope: 'global',
          status: 'active',
          userFavorite: false,
          canEdit: false,
          actionCount: 0,
          tags: [],
        },
      ],
    }),
  } as unknown as DustClient

  const config = loadConfig({
    INTERNAL_TOKEN,
    PROXY_API_KEYS: 'k',
    LOG_LEVEL: 'silent',
    MODELS_FILE: '/nonexistent-models.json',
  } as NodeJS.ProcessEnv)

  return {
    ctx: {
      config: { ...config, dustDefaultAgentConfigurationId: 'Dev' },
      dust,
      router: new ModelRouter({ opus: { configurationId: 'agent-1' } }),
      sessions: new SessionStore(),
    },
    fake,
  }
}

describe('admin endpoints', () => {
  it('rejects a request without the internal token', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({ method: 'GET', url: '/internal/status' })
    expect(res.statusCode).toBe(403)
    await app.close()
  })

  it('reports the authenticated status', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/status',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.dust_auth).toBe('ok')
    expect(body.workspace).toBe('w-123')
    expect(body.region).toBe('europe-west1')
    expect(body.user.email).toBe('dev@example.com')
    expect(body.token_ttl_seconds).toBe(3600)
    expect(body.proxy.port).toBe(8080)
    await app.close()
  })

  it('reports a missing login with a hint', async () => {
    const app = buildServer(buildContext({ creds: null }).ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/status',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.json().dust_auth).toBe('missing')
    expect(res.json().hint).toContain('proxyctl login')
    await app.close()
  })

  it('logs out the running instance', async () => {
    const { ctx, fake } = buildContext()
    const app = buildServer(ctx)
    const res = await app.inject({
      method: 'POST',
      url: '/internal/logout',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.json()).toMatchObject({ ok: true, was_logged_in: true, workspace: 'w-123' })
    expect(fake.cleared).toBe(true)
    await app.close()
  })

  it('returns credit figures', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/credits',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.json()).toMatchObject({
      workspace: 'w-123',
      limit: 20000,
      used: 17342,
      remaining: 2658,
      timeframe: 'week',
      window_kind: 'rolling',
    })
    await app.close()
  })

  it('refuses credits when not logged in', async () => {
    const app = buildServer(buildContext({ creds: null }).ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/credits',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('returns the Dust model catalog', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/dust-models',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.workspace).toBe('w-123')
    expect(body.models[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      contextSize: 250000,
    })
    expect(body.streams[0].stream).toBe('auto')
    await app.close()
  })

  it('refuses the model catalog when not logged in', async () => {
    const app = buildServer(buildContext({ creds: null }).ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/dust-models',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('lists the workspace agents with their mapped models', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/agents',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.workspace).toBe('w-123')
    expect(body.default_agent).toBe('Dev')
    expect(body.agents[0]).toMatchObject({
      sId: 'agent-1',
      name: 'Dev',
      scope: 'hidden',
      modelId: 'claude-opus-5',
      models: ['opus'],
      // Matched by name: DUST_DEFAULT_AGENT_CONFIGURATION_ID is not an sId here.
      isDefault: true,
    })
    expect(body.agents[1]).toMatchObject({ sId: 'agent-2', models: [], isDefault: false })
    await app.close()
  })

  it('refuses the agent list when not logged in', async () => {
    const app = buildServer(buildContext({ creds: null }).ctx)
    const res = await app.inject({
      method: 'GET',
      url: '/internal/agents',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('validates the login poll body', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'POST',
      url: '/internal/login/poll',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('reports already_logged_in unless forced', async () => {
    const app = buildServer(buildContext().ctx)
    const res = await app.inject({
      method: 'POST',
      url: '/internal/login/start',
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      payload: {},
    })
    expect(res.json()).toMatchObject({ status: 'already_logged_in', workspace: 'w-123' })
    await app.close()
  })
})
