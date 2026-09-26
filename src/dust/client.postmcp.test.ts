import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DustClient } from './client.js'
import { Config } from '../config.js'
import { Credentials, CredentialStore } from '../auth/credentials.js'

// A syntactically valid JWT whose `exp` is far in the future, so `ensureFreshToken`
// never triggers a refresh.
function token(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url')
  return `h.${payload}.s`
}

const creds: Credentials = {
  accessToken: token(),
  refreshToken: 'refresh',
  workspaceSid: 'ws1',
  region: 'us-central1',
  updatedAt: new Date().toISOString(),
}

function config(): Config {
  return {
    dustBaseUrl: 'https://dust.test',
    dustOAuthClientId: 'client',
    timeouts: { createMessageMs: 1000, idleStreamMs: 1000 },
  } as Config
}

function store(): CredentialStore {
  return {
    load: vi.fn(async () => creds),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } as unknown as CredentialStore
}

async function clientWithFetch(
  responses: (() => Promise<Response> | Response)[],
): Promise<{ client: DustClient; fetchMock: ReturnType<typeof vi.fn>; warns: unknown[][] }> {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected extra fetch')
    return next()
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = new DustClient(config(), store())
  await client.init()
  const warns: unknown[][] = []
  client.logger = { warn: (...args: unknown[]) => warns.push(args) }
  return { client, fetchMock: fetchMock as unknown as ReturnType<typeof vi.fn>, warns }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const RESULT = { jsonrpc: '2.0', id: 7, result: { content: [] } }

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DustClient.postMcpResult', () => {
  it('posts the result once on success', async () => {
    const { client, fetchMock } = await clientWithFetch([() => json({ success: true })])
    await expect(client.postMcpResult('srv', RESULT)).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx and succeeds', async () => {
    const { client, fetchMock, warns } = await clientWithFetch([
      () => json({ error: { message: 'boom' } }, 503),
      () => json({ success: true }),
    ])
    await expect(client.postMcpResult('srv', RESULT)).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Each replay is logged: `mcp/results` has no idempotency key (issue #35 §3).
    expect(JSON.stringify(warns)).toContain('not idempotent')
  })

  it('retries a 429 then a network error, then succeeds', async () => {
    const { client, fetchMock } = await clientWithFetch([
      () => json({ error: { message: 'slow down' } }, 429),
      () => {
        throw new Error('fetch failed')
      },
      () => json({ success: true }),
    ])
    await expect(client.postMcpResult('srv', RESULT)).resolves.toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 4xx (needs a re-registration, not a replay)', async () => {
    const { client, fetchMock } = await clientWithFetch([
      () => json({ error: { message: 'unknown serverId' } }, 400),
    ])
    await expect(client.postMcpResult('srv', RESULT)).rejects.toThrow('unknown serverId')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after 3 attempts and surfaces the last error', async () => {
    const { client, fetchMock } = await clientWithFetch([
      () => json({ error: { message: 'boom 1' } }, 500),
      () => json({ error: { message: 'boom 2' } }, 500),
      () => json({ error: { message: 'boom 3' } }, 500),
    ])
    await expect(client.postMcpResult('srv', RESULT)).rejects.toThrow('boom 3')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects an unexpected response body without retrying', async () => {
    const { client, fetchMock } = await clientWithFetch([() => json({ nope: true })])
    await expect(client.postMcpResult('srv', RESULT)).rejects.toThrow(
      'Unexpected mcp/results response',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
