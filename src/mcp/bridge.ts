import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Config } from '../config.js'
import { DustMcpTransport, McpEndpoint } from '../dust/mcp.js'
import {
  AnthropicTool,
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
  resolve: (result: ToolCallResult) => void
  reject: (err: Error) => void
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

  // Resolve a parked tool call from an incoming Claude Code `tool_result` block.
  resolveToolResult(toolUseId: string, content: unknown, isError: boolean): boolean {
    const pending = this.pending.get(toolUseId)
    if (!pending) return false
    this.pending.delete(toolUseId)
    pending.resolve({ text: toolResultToText(content), isError })
    return true
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.activeEmitter = null
    for (const p of this.pending.values()) {
      p.reject(new Error('MCP bridge closed'))
    }
    this.pending.clear()
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
        async (args) =>
          this.relayToolCall(tool.name, (args ?? {}) as Record<string, unknown>),
      )
      this.registeredTools.set(tool.name, registered)
    }
  }

  private async relayToolCall(
    name: string,
    input: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const toolUseId = `toolu_${randomBytes(16).toString('hex')}`
    const result = new Promise<ToolCallResult>((resolve, reject) => {
      this.pending.set(toolUseId, { toolUseId, name, input, resolve, reject })
    })
    // Emit the tool_use block on the active streaming reply. Claude Code runs the
    // tool locally and returns a tool_result in its next request, which
    // `resolveToolResult` uses to settle this promise.
    this.activeEmitter?.emitToolUse(toolUseId, name, input)
    const res = await result
    return {
      content: [{ type: 'text', text: res.text }],
      isError: res.isError,
    }
  }
}

function sameToolNames(a: AnthropicTool[], b: AnthropicTool[]): boolean {
  if (a.length !== b.length) return false
  const names = new Set(a.map((t) => t.name))
  return b.every((t) => names.has(t.name))
}
