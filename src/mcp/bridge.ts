import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Config } from '../config.js'
import { DustMcpTransport, McpEndpoint } from '../dust/mcp.js'
import {
  AnthropicTool,
  coerceToolInput,
  jsonSchemaToZod,
  toolResultToText,
} from '../anthropic/tools.js'

// Session-scoped orchestration of the client-side MCP bridge. One `SessionMcp`
// per tool-capable Claude Code session: it owns a `DustMcpTransport` + an official
// `McpServer`, declares the Claude Code `tools[]` on it, and relays each Dust
// `tools/call` to Claude Code as a `tool_use` block (correlated back to a
// `tool_result` via the Anthropic `tool_use_id`).

export interface ToolUseEmitter {
  emitToolUse(toolUseId: string, name: string, input: unknown): void
}

export interface ToolCallResult {
  text: string
  isError: boolean
}

interface PendingToolCall {
  toolUseId: string
  name: string
  input: unknown
  requestId?: unknown
  resolve: (result: ToolCallResult) => void
  reject: (err: Error) => void
  delivered: {
    promise: Promise<void>
    resolve: () => void
    reject: (err: Error) => void
  }
}

// Outcome of delivering a Claude Code tool_result back to Dust. The distinction
// between `failed` (matched but Dust rejected it) and `unknown` (no parked call
// matches this id — e.g. a replayed history) drives different error handling.
export type ToolResultDelivery =
  | { status: 'delivered' }
  | { status: 'failed'; error: string }
  | { status: 'unknown' }

function deferred(): PendingToolCall['delivered'] {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export interface McpLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

export class SessionMcp {
  private transport: DustMcpTransport | null = null
  private server: McpServer | null = null
  private serverId: string | null = null
  private pending = new Map<string, PendingToolCall>()
  // JSON-RPC request id → pending call, so the transport can report which tool
  // result was delivered once `send()` completes.
  private requestIdToPending = new Map<unknown, PendingToolCall>()
  private registeredTools = new Map<string, RegisteredTool>()
  private tools: AnthropicTool[] = []
  private activeEmitter: ToolUseEmitter | null = null
  private started = false
  private closed = false

  constructor(
    private readonly endpoint: McpEndpoint,
    private readonly config: Config,
    private readonly logger?: McpLogger,
  ) {}

  get id(): string | undefined {
    return this.serverId ?? undefined
  }

  async start(tools: AnthropicTool[]): Promise<void> {
    if (this.closed) return
    if (this.started) {
      this.declareTools(tools)
      return
    }
    this.started = true
    this.tools = tools

    this.transport = new DustMcpTransport({
      endpoint: this.endpoint,
      serverName: this.config.mcpServerName,
      heartbeatIntervalMs: this.config.mcpHeartbeatIntervalMs,
      reconnectDelayMs: this.config.mcpReconnectDelayMs,
      onServerId: (serverId) => {
        this.serverId = serverId
      },
      onError: (err) => this.logger?.error?.(err),
      onMessageDelivered: (messageId, ok, error) =>
        this.handleMessageDelivered(messageId, ok, error),
    })

    this.server = new McpServer({
      name: this.config.mcpServerName,
      version: '0.1.0',
    })
    this.declareToolsOnServer(tools)
    // `connect` sets transport.onmessage/onclose/onerror and calls start(), which
    // registers with Dust (surfacing `serverId` via onServerId) and opens the SSE
    // requests stream.
    await this.server.connect(this.transport)
  }

  // Wire the active streaming reply so tool calls can emit `tool_use` blocks.
  setEmitter(emitter: ToolUseEmitter | null): void {
    this.activeEmitter = emitter
  }

  declareTools(tools: AnthropicTool[]): void {
    if (this.closed || !this.server) return
    if (sameToolNames(this.tools, tools)) return
    this.tools = tools
    this.declareToolsOnServer(tools)
  }

  // Resolve a parked tool call from an incoming Claude Code `tool_result` block and
  // await its delivery back to Dust. Returning only after delivery means the caller
  // can fail fast on a rejected result instead of leaving the generation parked
  // until the stream's idle timeout fires.
  async resolveToolResult(
    toolUseId: string,
    content: unknown,
    isError: boolean,
  ): Promise<ToolResultDelivery> {
    const pending = this.pending.get(toolUseId)
    if (!pending) return { status: 'unknown' }
    // Settle the SDK handler so it returns the result and `transport.send()` posts
    // it to Dust; the transport then reports delivery via `handleMessageDelivered`.
    pending.resolve({ text: toolResultToText(content), isError })

    let delivery: ToolResultDelivery
    if (pending.requestId == null) {
      // Without a JSON-RPC id we cannot observe delivery; assume the best rather
      // than hang the turn.
      delivery = { status: 'delivered' }
    } else {
      delivery = await withTimeout(
        pending.delivered.promise,
        // The delivery path retries `mcp/results` a few times, each bounded by
        // `createMessageMs`; leave comfortable margin over that worst case.
        this.config.timeouts.createMessageMs * 5,
      ).then(
        () => ({ status: 'delivered' as const }),
        (err: unknown) => ({
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }

    this.pending.delete(toolUseId)
    if (pending.requestId != null) this.requestIdToPending.delete(pending.requestId)
    return delivery
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.activeEmitter = null
    for (const p of this.pending.values()) {
      const err = new Error('MCP bridge closed')
      p.reject(err)
      p.delivered.reject(err)
    }
    this.pending.clear()
    this.requestIdToPending.clear()
    if (this.transport) {
      await this.transport.close().catch(() => {})
    }
    this.transport = null
    this.server = null
    this.serverId = null
    this.started = false
  }

  private declareToolsOnServer(tools: AnthropicTool[]): void {
    if (!this.server) return
    const newNames = new Set(tools.map((t) => t.name))
    for (const [name, registered] of this.registeredTools) {
      if (!newNames.has(name)) {
        registered.remove()
        this.registeredTools.delete(name)
      }
    }
    for (const tool of tools) {
      if (this.registeredTools.has(tool.name)) continue
      const registered = this.server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: jsonSchemaToZod(tool.input_schema),
        },
        async (args, extra) =>
          this.relayToolCall(
            tool.name,
            (args ?? {}) as Record<string, unknown>,
            (extra as { requestId?: unknown } | undefined)?.requestId,
          ),
      )
      this.registeredTools.set(tool.name, registered)
    }
  }

  private async relayToolCall(
    name: string,
    input: Record<string, unknown>,
    requestId?: unknown,
  ): Promise<CallToolResult> {
    const toolUseId = `toolu_${randomBytes(16).toString('hex')}`
    // Normalize the model's arguments against the declared schema before emitting
    // the `tool_use`: a non-string `command` (object/number/array) otherwise reaches
    // Claude Code, whose local validation rejects it as "command expected string".
    const schema = this.tools.find((t) => t.name === name)?.input_schema
    const sanitized = coerceToolInput(input, schema)
    if (JSON.stringify(sanitized) !== JSON.stringify(input)) {
      this.logger?.warn?.(
        { name, before: input, after: sanitized },
        'coerced tool input to match schema string fields',
      )
    }
    const result = new Promise<ToolCallResult>((resolve, reject) => {
      const pending: PendingToolCall = {
        toolUseId,
        name,
        input: sanitized,
        requestId,
        resolve,
        reject,
        delivered: deferred(),
      }
      this.pending.set(toolUseId, pending)
      if (requestId != null) this.requestIdToPending.set(requestId, pending)
    })
    // Emit the tool_use block on the active streaming reply. Claude Code runs the
    // tool locally and returns a tool_result in its next request, which
    // `resolveToolResult` uses to settle this promise.
    this.activeEmitter?.emitToolUse(toolUseId, name, sanitized)
    const res = await result
    return {
      content: [{ type: 'text', text: res.text }],
      isError: res.isError,
    }
  }

  private handleMessageDelivered(messageId: unknown, ok: boolean, error?: Error): void {
    const pending = this.requestIdToPending.get(messageId)
    if (!pending) return
    if (ok) pending.delivered.resolve()
    else pending.delivered.reject(error ?? new Error('Tool result delivery failed'))
  }
}

function sameToolNames(a: AnthropicTool[], b: AnthropicTool[]): boolean {
  if (a.length !== b.length) return false
  const names = new Set(a.map((t) => t.name))
  return b.every((t) => names.has(t.name))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
