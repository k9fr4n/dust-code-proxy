import { describe, it, expect, vi } from 'vitest'
import { SessionMcp } from './bridge.js'
import { McpEndpoint } from '../dust/mcp.js'
import { Config } from '../config.js'
import { AnthropicTool } from '../anthropic/tools.js'

function makeEndpoint(overrides: Partial<McpEndpoint> = {}): McpEndpoint & {
  postMcpResult: ReturnType<typeof vi.fn>
} {
  return {
    registerMcpServer: vi.fn(async () => ({
      serverId: 'srv_bridge',
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    heartbeatMcpServer: vi.fn(async () => ({
      success: true,
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    postMcpResult: vi.fn(async () => ({ success: true })),
    streamMcpRequests: vi.fn(async function* () {
      // Idle SSE stream that never yields.
      await new Promise<void>(() => {})
    }),
    ...overrides,
  } as McpEndpoint & { postMcpResult: ReturnType<typeof vi.fn> }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    mcpServerName: 'test-bridge',
    mcpHeartbeatIntervalMs: 60_000,
    mcpReconnectDelayMs: 60_000,
    ...overrides,
  } as Config
}

// Reach into the transport the bridge owns so we can feed it JSON-RPC messages as
// though they arrived over the Dust MCP requests stream.
function onmessage(bridge: SessionMcp): (message: unknown) => void {
  const transport = (bridge as unknown as {
    transport: { onmessage?: (message: unknown) => void }
  }).transport
  return transport.onmessage!
}

const ECHO: AnthropicTool = {
  name: 'echo',
  description: 'echoes text',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
}

describe('SessionMcp', () => {
  it('registers with Dust and declares tools on start', async () => {
    const ep = makeEndpoint()
    const bridge = new SessionMcp(ep, config())
    await bridge.start([ECHO])
    expect(ep.registerMcpServer).toHaveBeenCalledWith('test-bridge')
    expect(bridge.id).toBe('srv_bridge')
    await bridge.close()
  })

  it('relays a tools/call to the emitter and posts the resolved result back', async () => {
    const ep = makeEndpoint()
    const bridge = new SessionMcp(ep, config())
    await bridge.start([ECHO])

    const emitted: { toolUseId: string; name: string; input: unknown }[] = []
    bridge.setEmitter({
      emitToolUse(toolUseId, name, input) {
        emitted.push({ toolUseId, name, input })
      },
    })

    onmessage(bridge)({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    })

    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(emitted[0]).toMatchObject({ name: 'echo', input: { text: 'hi' } })

    const toolUseId = emitted[0].toolUseId
    expect(bridge.resolveToolResult(toolUseId, 'hi back', false)).toBe(true)

    await vi.waitFor(() => expect(ep.postMcpResult).toHaveBeenCalled())
    const [serverId, result] = ep.postMcpResult.mock.calls[0]
    expect(serverId).toBe('srv_bridge')
    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      result: { content: [{ type: 'text', text: 'hi back' }], isError: false },
    })
    await bridge.close()
  })

  it('correlates concurrent tool calls independently', async () => {
    const ep = makeEndpoint()
    const bridge = new SessionMcp(ep, config())
    await bridge.start([ECHO])

    const emitted: { toolUseId: string }[] = []
    bridge.setEmitter({
      emitToolUse(toolUseId) {
        emitted.push({ toolUseId })
      },
    })

    onmessage(bridge)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } })
    onmessage(bridge)({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: {} } })

    await vi.waitFor(() => expect(emitted).toHaveLength(2))

    // Resolve out of order.
    expect(bridge.resolveToolResult(emitted[1].toolUseId, 'two', false)).toBe(true)
    expect(bridge.resolveToolResult(emitted[0].toolUseId, 'one', false)).toBe(true)

    await vi.waitFor(() => expect(ep.postMcpResult).toHaveBeenCalledTimes(2))
    const posted = ep.postMcpResult.mock.calls.map(([, r]) => (r as { id: number }).id).sort()
    expect(posted).toEqual([1, 2])
    await bridge.close()
  })

  it('returns false when resolving an unknown tool_use_id', async () => {
    const bridge = new SessionMcp(makeEndpoint(), config())
    await bridge.start([ECHO])
    expect(bridge.resolveToolResult('toolu_missing', 'x', false)).toBe(false)
    await bridge.close()
  })

  it('declareTools is a no-op when the tool set is unchanged', async () => {
    const ep = makeEndpoint()
    const bridge = new SessionMcp(ep, config())
    await bridge.start([ECHO])
    const streamCalls = ep.streamMcpRequests.mock.calls.length
    bridge.declareTools([ECHO])
    expect(ep.streamMcpRequests.mock.calls.length).toBe(streamCalls)
    await bridge.close()
  })

  it('close() is idempotent and tears down', async () => {
    const bridge = new SessionMcp(makeEndpoint(), config())
    await bridge.start([ECHO])
    await bridge.close()
    await bridge.close()
    expect(bridge.id).toBeUndefined()
  })
})
