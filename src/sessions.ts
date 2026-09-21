import { randomUUID } from 'node:crypto'

// A session binds a Claude Code session to a single Dust conversation (and, in a
// later phase, to a registered MCP serverId). Stored in memory: the MVP runs as a
// single instance. The stable `key` is how requests identify their session; `id` is
// a correlation id for logs.
export interface Session {
  id: string
  key: string
  clientKeyId: string
  workspaceId: string
  conversationId?: string
  agentConfigurationId?: string
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
    this.sessions.delete(key)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }
}
