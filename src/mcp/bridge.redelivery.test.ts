import { describe, it, expect, vi } from 'vitest'
import { SessionMcp } from './bridge.js'
import { McpEndpoint } from '../dust/mcp.js'
import { Config } from '../config.js'
import { AnthropicTool } from '../anthropic/tools.js'

// Regression coverage for issue #35 §2: a tool result whose delivery to Dust fails
// must remain re-deliverable. Before the fix the pending call was dropped on
// failure, so Claude Code's retry reported `unknown` and the result was lost for
// good, leaving the Dust generation parked forever.

function config(): Config {
  return {
    mcpServerName: 'test-bridge',
    mcpHeartbeatIntervalMs: 60_000,
    mcpReconnectDelayMs: 60_000,
    timeouts: { createMessageMs: 500 },
  } as Config
}

function onmessage(bridge: SessionMcp): (message: unknown) => void {
  const transport = (bridge as unknown as {
    transport: { onmessage?: (message: unknown) => void }
  }).transport
  return transport.onmessage!
}

const ECHO: AnthropicTool = {
  name: 'echo',
  description: 'echoes text',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
}

function endpoint(postMcpResult: McpEndpoint['postMcpResult']): McpEndpoint {
  return {
    registerMcpServer: vi.fn(async () => ({
      serverId: 'srv_bridge',
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    heartbeatMcpServer: vi.fn(async () => ({
      success: true,
      expiresAt: '2026-01-01T00:00:00.000Z',
    })),
    postMcpResult,
    streamMcpRequests: vi.fn(async function* () {
      await new Promise<void>(() => {})
    }),
  }
}

async function parkedToolCall(ep: McpEndpoint): Promise<{ bridge: SessionMcp; toolUseId: string }> {
  const bridge = new SessionMcp(ep, config())
  await bridge.start([ECHO])
  const emitted: string[] = []
  bridge.setEmitter({
    emitToolUse(toolUseId) {
      emitted.push(toolUseId)
    },
  })
  onmessage(bridge)({
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hi' } },
  })
  await vi.waitFor(() => expect(emitted).toHaveLength(1))
  return { bridge, toolUseId: emitted[0] }
}

describe('SessionMcp tool-result re-delivery', () => {
  it('re-delivers a failed tool result when Claude Code retries', async () => {
    const posted: unknown[] = []
    let fail = true
    const ep = endpoint(
      vi.fn(async (_serverId: string, result: unknown) => {
        posted.push(result)
        if (fail) throw new Error('Dust 503')
        return { success: true }
      }),
    )
    const { bridge, toolUseId } = await parkedToolCall(ep)

    // First attempt: Dust rejects the delivery.
    await expect(bridge.resolveToolResult(toolUseId, 'hi back', false)).resolves.toMatchObject({
      status: 'failed',
    })

    // Retry of the same tool_result: re-posted instead of being reported `unknown`.
    fail = false
    await expect(bridge.resolveToolResult(toolUseId, 'hi back', false)).resolves.toEqual({
      status: 'delivered',
    })
    expect(posted).toHaveLength(2)
    // The replay is the exact JSON-RPC response the SDK would have sent.
    expect(posted[1]).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      result: { content: [{ type: 'text', text: 'hi back' }], isError: false },
    })

    // Once delivered, the result is no longer pending: a further replay is unknown.
    await expect(bridge.resolveToolResult(toolUseId, 'hi back', false)).resolves.toEqual({
      status: 'unknown',
    })
    await bridge.close()
  })

  it('reports a still-failing re-delivery as failed (never silently unknown)', async () => {
    const ep = endpoint(
      vi.fn(async () => {
        throw new Error('Dust 503')
      }),
    )
    const { bridge, toolUseId } = await parkedToolCall(ep)
    await expect(bridge.resolveToolResult(toolUseId, 'out', false)).resolves.toMatchObject({
      status: 'failed',
    })
    await expect(bridge.resolveToolResult(toolUseId, 'out', false)).resolves.toMatchObject({
      status: 'failed',
    })
    await bridge.close()
  })

  it('still reports an unrelated tool_use_id as unknown', async () => {
    const ep = endpoint(vi.fn(async () => ({ success: true })))
    const bridge = new SessionMcp(ep, config())
    await bridge.start([ECHO])
    await expect(bridge.resolveToolResult('toolu_nope', 'x', false)).resolves.toEqual({
      status: 'unknown',
    })
    await bridge.close()
  })

  it('fails a re-delivery attempted after the bridge is closed', async () => {
    const ep = endpoint(
      vi.fn(async () => {
        throw new Error('Dust 503')
      }),
    )
    const { bridge, toolUseId } = await parkedToolCall(ep)
    await expect(bridge.resolveToolResult(toolUseId, 'out', false)).resolves.toMatchObject({
      status: 'failed',
    })
    const failed = (bridge as unknown as { failedDeliveries: Map<string, unknown> })
      .failedDeliveries
    expect(failed.has(toolUseId)).toBe(true)
    await bridge.close()
    expect(failed.size).toBe(0)
  })
})
