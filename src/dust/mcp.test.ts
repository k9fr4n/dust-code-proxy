import { describe, it, expect, vi } from 'vitest'
import { DustMcpTransport, McpEndpoint } from './mcp.js'
import { ParsedMcpRequest } from './sse.js'

function endpoint(overrides: Partial<McpEndpoint> = {}): McpEndpoint {
  return {
    registerMcpServer: vi.fn(async () => ({
      serverId: 'srv_1',
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    heartbeatMcpServer: vi.fn(async () => ({
      success: true,
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    postMcpResult: vi.fn(async () => ({ success: true })),
    streamMcpRequests: vi.fn(async function* () {
      // Never yields, never ends: an idle SSE stream.
      await new Promise<void>(() => {})
    }),
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('DustMcpTransport', () => {
  it('registers, opens the stream, and delivers events to onmessage', async () => {
    const ep = endpoint({
      streamMcpRequests: vi.fn(async function* () {
        yield { kind: 'event', eventId: '1', data: { jsonrpc: '2.0', method: 'tools/call' } }
        await new Promise<void>(() => {})
      }),
    })
    const transport = new DustMcpTransport({ endpoint: ep, serverName: 'test-server' })
    const messages: unknown[] = []
    transport.onmessage = (m) => messages.push(m)

    await transport.start()
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(ep.registerMcpServer).toHaveBeenCalledWith('test-server')
    expect(transport.getServerId()).toBe('srv_1')
    expect(ep.streamMcpRequests).toHaveBeenCalledWith('srv_1', null, expect.anything())
    await transport.close()
  })

  it('ignores the done sentinel', async () => {
    const ep = endpoint({
      streamMcpRequests: vi.fn(async function* () {
        yield { kind: 'done' }
        yield { kind: 'event', eventId: '2', data: { method: 'tools/list' } }
        await new Promise<void>(() => {})
      }),
    })
    const transport = new DustMcpTransport({ endpoint: ep, serverName: 'test-server' })
    const messages: unknown[] = []
    transport.onmessage = (m) => messages.push(m)

    await transport.start()
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toEqual({ method: 'tools/list' })
    await transport.close()
  })

  it('tracks lastEventId and passes it to a reconnect', async () => {
    let calls = 0
    const stream = vi.fn(async function* () {
      calls += 1
      if (calls === 1) {
        yield { kind: 'event', eventId: '7', data: { method: 'tools/call' } }
        // End cleanly: the transport schedules a reconnect.
        return
      }
      // Subsequent streams stay open.
      await new Promise<void>(() => {})
    })
    const ep = endpoint({ streamMcpRequests: stream })
    const transport = new DustMcpTransport({
      endpoint: ep,
      serverName: 'test-server',
      reconnectDelayMs: 10,
    })

    await transport.start()
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    // Second call resumes from the last seen eventId.
    expect(stream).toHaveBeenNthCalledWith(2, 'srv_1', '7', expect.anything())
    await transport.close()
  })

  it('re-registers when the heartbeat reports failure', async () => {
    const ep = endpoint({
      registerMcpServer: vi.fn(async () => ({
        serverId: 'srv_2',
        expiresAt: '2026-01-01T00:00:00.000Z',
      })),
      heartbeatMcpServer: vi.fn(async () => ({
        success: false,
        expiresAt: '2026-01-01T00:00:00.000Z',
      })),
    })
    const transport = new DustMcpTransport({
      endpoint: ep,
      serverName: 'test-server',
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 10,
    })

    await transport.start()
    await vi.waitFor(() => expect(ep.registerMcpServer.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(transport.getServerId()).toBe('srv_2')
    await transport.close()
  })

  it('reconnects after an SSE stream error', async () => {
    let calls = 0
    const stream = vi.fn(async function* () {
      calls += 1
      if (calls === 1) {
        throw new Error('connection reset')
      }
      await new Promise<void>(() => {})
    })
    const onError = vi.fn()
    const ep = endpoint({ streamMcpRequests: stream })
    const transport = new DustMcpTransport({
      endpoint: ep,
      serverName: 'test-server',
      reconnectDelayMs: 10,
      onError,
    })

    await transport.start()
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalled()
    await transport.close()
  })

  it('posts results via send()', async () => {
    const ep = endpoint()
    const transport = new DustMcpTransport({ endpoint: ep, serverName: 'test-server' })
    await transport.start()
    await flush()
    await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [] } } as never)
    expect(ep.postMcpResult).toHaveBeenCalledWith(
      'srv_1',
      expect.objectContaining({ id: 1 }),
    )
    await transport.close()
  })

  it('reports delivery outcome via onMessageDelivered', async () => {
    const ep = endpoint()
    const delivered: { id: unknown; ok: boolean }[] = []
    const transport = new DustMcpTransport({
      endpoint: ep,
      serverName: 'test-server',
      onMessageDelivered: (id, ok) => delivered.push({ id, ok }),
    })
    await transport.start()
    await flush()
    await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [] } } as never)
    expect(delivered).toEqual([{ id: 1, ok: true }])
    await transport.close()
  })

  it('reports a failed delivery outcome when the post throws', async () => {
    const ep = endpoint({
      postMcpResult: vi.fn(async () => {
        throw new Error('upstream 502')
      }),
    })
    const delivered: { id: unknown; ok: boolean }[] = []
    const transport = new DustMcpTransport({
      endpoint: ep,
      serverName: 'test-server',
      onMessageDelivered: (id, ok) => delivered.push({ id, ok }),
    })
    await transport.start()
    await flush()
    await transport.send({ jsonrpc: '2.0', id: 1, result: { content: [] } } as never)
    expect(delivered).toEqual([{ id: 1, ok: false }])
    await transport.close()
  })

  it('reports an error when send() is called before registration', async () => {
    const ep = endpoint()
    const onError = vi.fn()
    const transport = new DustMcpTransport({ endpoint: ep, serverName: 'test-server', onError })
    await transport.send({ jsonrpc: '2.0', id: 1 } as never)
    expect(onError).toHaveBeenCalled()
    expect(ep.postMcpResult).not.toHaveBeenCalled()
  })
})

// Issue #35 §5: Dust closes the `mcp/requests` stream roughly every 150 s. The
// transport reconnects on its own, so those drops must be reported as recoverable
// drops (logged `warn`) instead of transport errors (logged `error`).
describe('DustMcpTransport recoverable stream drops', () => {
  it('reports a transient drop through onStreamDrop, not onError', async () => {
    let calls = 0
    const stream = vi.fn(async function* () {
      calls += 1
      if (calls === 1) throw new Error('terminated: other side closed')
      await new Promise<void>(() => {})
    })
    const onError = vi.fn()
    const onStreamDrop = vi.fn()
    const transport = new DustMcpTransport({
      endpoint: endpoint({ streamMcpRequests: stream }),
      serverName: 'test-server',
      reconnectDelayMs: 10,
      onError,
      onStreamDrop,
    })

    await transport.start()
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(onStreamDrop).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    await transport.close()
  })

  it('still reports a non-transient stream failure as an error', async () => {
    let calls = 0
    const stream = vi.fn(async function* () {
      calls += 1
      if (calls === 1) throw new Error('Dust MCP stream failed (500): nope')
      await new Promise<void>(() => {})
    })
    const onError = vi.fn()
    const onStreamDrop = vi.fn()
    const transport = new DustMcpTransport({
      endpoint: endpoint({ streamMcpRequests: stream }),
      serverName: 'test-server',
      reconnectDelayMs: 10,
      onError,
      onStreamDrop,
    })

    await transport.start()
    await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(2))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onStreamDrop).not.toHaveBeenCalled()
    await transport.close()
  })
})
