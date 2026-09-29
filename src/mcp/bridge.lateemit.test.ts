import { describe, it, expect, vi } from 'vitest'
import { SessionMcp } from './bridge.js'
import { McpEndpoint } from '../dust/mcp.js'
import { Config } from '../config.js'
import { AnthropicTool } from '../anthropic/tools.js'

// Regression cover for lost `tool_use` blocks. Dust dispatches a batch of parallel
// tool calls as independent MCP requests spread over several hundred ms, while a
// streaming reply closes on a short debounce after the first `tool_use`. Stragglers
// used to be emitted through an optional-chained call on a null emitter, which
// dropped them silently: Dust then waited forever on a `tool_result` Claude Code had
// never seen, stopped emitting events, and the stream died on the idle timeout while
// the agent-side conversation stopped mid-flight.

function makeEndpoint(): McpEndpoint & { postMcpResult: ReturnType<typeof vi.fn> } {
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
      await new Promise<void>(() => {})
    }),
  } as unknown as McpEndpoint & { postMcpResult: ReturnType<typeof vi.fn> }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    mcpServerName: 'test-bridge',
    mcpHeartbeatIntervalMs: 60_000,
    mcpReconnectDelayMs: 60_000,
    toolUseQueueTimeoutMs: 60_000,
    timeouts: { createMessageMs: 1000 },
    ...overrides,
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

function call(bridge: SessionMcp, id: number, text: string): void {
  onmessage(bridge)({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'echo', arguments: { text } },
  })
}

type Emitted = { toolUseId: string; name: string; input: unknown }

function collector(sink: Emitted[]) {
  return {
    emitToolUse(toolUseId: string, name: string, input: unknown) {
      sink.push({ toolUseId, name, input })
    },
  }
}

describe('SessionMcp late tool_use emission', () => {
  it('queues a tool call that arrives with no active reply, and replays it on the next turn', async () => {
    const bridge = new SessionMcp(makeEndpoint(), config())
    await bridge.start([ECHO])

    // No reply attached: this is the window where the call used to vanish.
    call(bridge, 1, 'straggler')
    await new Promise((r) => setTimeout(r, 50))

    const emitted: Emitted[] = []
    bridge.setEmitter(collector(emitted))

    await vi.waitFor(() => expect(emitted).toHaveLength(1))
    expect(emitted[0]).toMatchObject({ name: 'echo', input: { text: 'straggler' } })

    // And it is a real parked call that can still be settled.
    await expect(
      bridge.resolveToolResult(emitted[0].toolUseId, 'ok', false),
    ).resolves.toEqual({ status: 'delivered' })

    await bridge.close()
  })

  it('does not lose the straggler of a parallel batch that lands after the reply closed', async () => {
    const bridge = new SessionMcp(makeEndpoint(), config())
    await bridge.start([ECHO])

    const turn1: Emitted[] = []
    bridge.setEmitter(collector(turn1))
    call(bridge, 1, 'first')
    await vi.waitFor(() => expect(turn1).toHaveLength(1))

    // The debounce fires and the reply closes while Dust is still dispatching.
    bridge.setEmitter(null)
    call(bridge, 2, 'second')
    await new Promise((r) => setTimeout(r, 50))
    expect(turn1).toHaveLength(1)

    // The tool-result turn opens a new reply: the straggler must surface there.
    const turn2: Emitted[] = []
    bridge.setEmitter(collector(turn2))
    await vi.waitFor(() => expect(turn2).toHaveLength(1))
    expect(turn2[0]).toMatchObject({ input: { text: 'second' } })
    expect(turn2[0].toolUseId).not.toBe(turn1[0].toolUseId)

    await bridge.close()
  })

  it('does not report a tool_use as emitted when it was only queued', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const bridge = new SessionMcp(makeEndpoint(), config(), logger)
    await bridge.start([ECHO])

    call(bridge, 1, 'quiet')
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled())

    const saidEmitted = logger.info.mock.calls.some((c) =>
      String(c[1]).includes('tool_use emitted'),
    )
    expect(saidEmitted).toBe(false)

    await bridge.close()
  })

  it('fails a queued tool call back to Dust when no reply ever attaches', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const bridge = new SessionMcp(
      makeEndpoint(),
      config({ toolUseQueueTimeoutMs: 30 }),
      logger,
    )
    await bridge.start([ECHO])

    call(bridge, 1, 'abandoned')

    await vi.waitFor(() =>
      expect(
        logger.error.mock.calls.some((c) =>
          String(c[1]).includes('queued tool_use expired'),
        ),
      ).toBe(true),
    )

    await bridge.close()
  })
})
