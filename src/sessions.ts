import { randomUUID } from 'node:crypto'

// A session binds a Claude Code session to a single Dust conversation and, when the
// client offers tools, to the client-side MCP bridge registered for it. Stored in
// memory: the MVP runs as a single instance. The stable `key` is how requests
// identify their session; `id` is a correlation id for logs.
//
// `mcp` is typed as the narrow `SessionMcpBridge` so `sessions.ts` need not import
// the concrete `SessionMcp` (which pulls in the SDK + client); any object exposing
// `close()` satisfies it.
export interface SessionMcpBridge {
  close(): Promise<void>
}

export interface Session {
  id: string
  key: string
  clientKeyId: string
  workspaceId: string
  conversationId?: string
  agentConfigurationId?: string
  // The Dust assistant message being streamed for the current turn. Persisted so a
  // `tool_result` continuation can resume the same message events stream.
  agentMessageId?: string
  // Last message-event id seen on the Dust message events stream, used to resume a
  // tool-result continuation from where the previous turn left off.
  lastEventId?: string
  mcp?: SessionMcpBridge
  lastActivityAt: number
}

const IDLE_TTL_MS = 24 * 60 * 60 * 1000

export class SessionStore {
  private sessions = new Map<string, Session>()

  get(key: string): Session | undefined {
    const session = this.sessions.get(key)
    if (!session) return undefined
    if (Date.now() - session.lastActivityAt > IDLE_TTL_MS) {
      this.sessions.delete(key)
      this.dispose(session)
      return undefined
    }
    return session
  }

  create(key: string, clientKeyId: string, workspaceId: string): Session {
    const session: Session = {
      id: randomUUID(),
      key,
      clientKeyId,
      workspaceId,
      lastActivityAt: Date.now(),
    }
    this.sessions.set(key, session)
    return session
  }

  touch(session: Session): void {
    session.lastActivityAt = Date.now()
  }

  delete(key: string): void {
    const session = this.sessions.get(key)
    this.sessions.delete(key)
    if (session) this.dispose(session)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  // Tear down a session's MCP bridge (heartbeat + SSE stream) when the session goes
  // away. Fire-and-forget: the caller never blocks on transport teardown.
  private dispose(session: Session): void {
    void session.mcp?.close().catch(() => {})
  }
}
