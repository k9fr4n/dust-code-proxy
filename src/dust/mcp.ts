import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { ParsedMcpRequest } from './sse.js'

// Client-side MCP bridge — faithful port of `DustMcpServerTransport` from the
// official `@dust-tt/client` SDK (src/mcp_transport.ts), adapted to this repo's
// idioms: Node `fetch` + manual SSE parsing instead of `event-source-polyfill`,
// and a narrow `McpEndpoint` interface implemented by `DustClient`.

// Confirmed schemas (src/types.ts of @dust-tt/client).
export const clientSideMcpServerNameSchema = z.string().min(5).max(30)
export const registerMcpResponseSchema = z.object({
  serverId: z.string(),
  expiresAt: z.string(),
})
export const heartbeatMcpResponseSchema = z.object({
  success: z.boolean(),
  expiresAt: z.string(),
})
export const postMcpResultsResponseSchema = z.object({ success: z.boolean() })

// The subset of `DustClient` the transport needs. Kept narrow so the transport
// can be unit-tested against a mock without the full client.
export interface McpEndpoint {
  registerMcpServer(
    serverName: string,
  ): Promise<{ serverId: string; expiresAt: string }>
  heartbeatMcpServer(
    serverId: string,
  ): Promise<{ success: boolean; expiresAt: string }>
  postMcpResult(serverId: string, result: unknown): Promise<{ success: boolean }>
  streamMcpRequests(
    serverId: string,
    lastEventId?: string | null,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedMcpRequest>
}

// The official doc says "no more than 5 minutes between two heartbeats"; the
// reference client hits exactly that limit. We leave margin and send early.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000
const DEFAULT_RECONNECT_DELAY_MS = 1 * 1000

export interface DustMcpTransportOptions {
  endpoint: McpEndpoint
  serverName: string
  heartbeatIntervalMs?: number
  reconnectDelayMs?: number
  onServerId?: (serverId: string) => void
  // The SDK's `McpServer.connect()` takes ownership of `Transport.onerror`, so this
  // separate callback is how the caller observes internal transport errors.
  onError?: (error: Error) => void
  // Fired after `send()` finishes posting a JSON-RPC message to Dust, keyed by the
  // message's JSON-RPC `id`. Lets the caller await (and react to) tool-result
  // delivery instead of leaving a parked generation to time out silently.
  onMessageDelivered?: (messageId: unknown, ok: boolean, error?: Error) => void
}

export class DustMcpTransport implements Transport {
  // Required by the Transport interface. `onmessage` is installed by the SDK's
  // `McpServer.connect()` before `start()` is called.
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void
  sessionId?: string

  private serverId: string | null = null
  private lastEventId: string | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private activeController: AbortController | null = null
  private closed = false

  constructor(private readonly options: DustMcpTransportOptions) {}

  getServerId(): string | undefined {
    return this.serverId ?? undefined
  }

  private reportError(err: Error): void {
    this.options.onError?.(err)
    this.onerror?.(err)
  }

  async start(): Promise<void> {
    const registered = await this.registerServer()
    if (!registered) {
      throw new Error('Failed to register MCP server')
    }
    this.runRequestStream()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const messageId = (message as { id?: unknown }).id
    if (!this.serverId) {
      const err = new Error('MCP server not registered; cannot send result.')
      this.reportError(err)
      this.options.onMessageDelivered?.(messageId, false, err)
      return
    }
    try {
      const res = await this.options.endpoint.postMcpResult(this.serverId, message)
      if (res.success === false) {
        const err = new Error('Dust rejected the MCP result (success: false).')
        this.reportError(err)
        this.options.onMessageDelivered?.(messageId, false, err)
        return
      }
      this.options.onMessageDelivered?.(messageId, true)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.reportError(e)
      this.options.onMessageDelivered?.(messageId, false, e)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearHeartbeat()
    this.clearReconnect()
    this.activeController?.abort()
    this.activeController = null
    this.onclose?.()
  }

  private async registerServer(): Promise<boolean> {
    try {
      const { serverId } = await this.options.endpoint.registerMcpServer(
        this.options.serverName,
      )
      this.serverId = serverId
      this.options.onServerId?.(serverId)
      this.setupHeartbeat(serverId)

      // If an SSE stream is already open (re-registration after a lost
      // heartbeat), it is still subscribed to the previous serverId's channel.
      // Reconnect to the new channel and drop the stale lastEventId.
      if (this.activeController) {
        this.lastEventId = null
        this.reconnectRequestStream()
      }
      return true
    } catch (err) {
      this.reportError(err instanceof Error ? err : new Error(String(err)))
      return false
    }
  }

  private setupHeartbeat(serverId: string): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(serverId),
      this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    )
  }

  private async heartbeat(serverId: string): Promise<void> {
    let ok = false
    try {
      const res = await this.options.endpoint.heartbeatMcpServer(serverId)
      ok = res.success === true
    } catch {
      ok = false
    }
    if (!ok) {
      // Heartbeat failure (network error OR success:false): the reference client
      // re-registers immediately, yielding a fresh serverId, resets lastEventId,
      // and reconnects the SSE stream on the new channel.
      await this.registerServer()
    }
  }

  private reconnectRequestStream(): void {
    this.activeController?.abort()
    this.activeController = null
    this.runRequestStream()
  }

  private runRequestStream(): void {
    if (this.closed || !this.serverId) return
    const serverId = this.serverId
    const controller = new AbortController()
    this.activeController = controller

    void (async () => {
      try {
        for await (const event of this.options.endpoint.streamMcpRequests(
          serverId,
          this.lastEventId,
          { signal: controller.signal },
        )) {
          if (event.kind === 'done') continue
          if (event.kind !== 'event') continue
          if (event.eventId) this.lastEventId = event.eventId
          this.onmessage?.(event.data as unknown as JSONRPCMessage)
        }
        // The stream ended cleanly (server closed it): reconnect indefinitely.
        if (!this.closed && !controller.signal.aborted) this.scheduleReconnect()
      } catch (err) {
        if (this.closed || controller.signal.aborted) return
        this.reportError(err instanceof Error ? err : new Error(String(err)))
        this.scheduleReconnect()
      }
    })()
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    this.clearReconnect()
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null
        this.runRequestStream()
      },
      this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    )
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
