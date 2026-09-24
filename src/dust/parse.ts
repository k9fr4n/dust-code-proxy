// Defensive parsing of Dust API response bodies.
//
// The public Dust documentation does not fully specify every response shape, and
// shapes differ between regions/versions. Every [hypothèse] is isolated in this
// file so that a single real login test can correct them in one place.

export interface DustAgentConfig {
  sId: string
  name: string
  // Enrichment from the manage view (see `DustClient.listRoutingAgents`): used by
  // the router to resolve a `models.json` `configurationId` that is a modelId (or
  // to disambiguate several agents sharing one). Absent when the public list is
  // used without enrichment — sId/name routing still works, modelId routing is off.
  modelId?: string
  scope?: string
  status?: string
  userFavorite?: boolean
}

export interface DustMessageInfo {
  sId: string
  type: string
  parentMessageId?: string
  content?: string
  status?: string
}

export interface DustWorkspaceInfo {
  sId: string
  name: string
  role?: string
}

export interface MeInfo {
  username?: string
  fullName?: string
  email?: string
  workspaces: DustWorkspaceInfo[]
}

const USER_TYPES = new Set(['user_message', 'user'])
const AGENT_TYPES = new Set(['agent_message', 'agent', 'assistant'])

export function parseMe(json: unknown): MeInfo {
  const obj = (json ?? {}) as Record<string, any>
  const user = obj.user ?? obj.me ?? obj
  const rawWorkspaces =
    user?.workspaces ??
    obj.workspaces ??
    obj.memberships ??
    (Array.isArray(obj) ? obj : [])
  const workspaces = (Array.isArray(rawWorkspaces) ? rawWorkspaces : [])
    .map((w: any) => ({
      sId: w?.sId ?? w?.id ?? w?.workspaceId ?? w?.workspace_sid,
      name: w?.name ?? w?.sId ?? w?.id ?? '',
      role: w?.role,
    }))
    .filter((w) => typeof w.sId === 'string')
  return {
    username: user?.username,
    fullName: user?.fullName,
    email: user?.email,
    workspaces,
  }
}

export function parseAgentConfigurations(json: unknown): DustAgentConfig[] {
  const obj = (json ?? {}) as Record<string, any>
  const arr = Array.isArray(obj)
    ? obj
    : obj.agentConfigurations ?? obj.configurations ?? []
  return (Array.isArray(arr) ? arr : [])
    .map((a: any) => ({
      sId: a?.sId ?? a?.id ?? a?.configurationId,
      name: a?.name ?? a?.sId ?? '',
    }))
    .filter((a) => typeof a.sId === 'string')
}

export function extractMessages(conversation: unknown): DustMessageInfo[] {
  const out: DustMessageInfo[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const obj = node as Record<string, any>
    if (typeof obj.sId === 'string' && typeof obj.type === 'string') {
      if (USER_TYPES.has(obj.type) || AGENT_TYPES.has(obj.type)) {
        out.push({
          sId: obj.sId,
          type: obj.type,
          parentMessageId:
            obj.parentMessageId ??
            obj.parentId ??
            (typeof obj.parent?.sId === 'string' ? obj.parent.sId : undefined),
          content: typeof obj.content === 'string' ? obj.content : undefined,
          status: typeof obj.status === 'string' ? obj.status : undefined,
        })
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const value of Object.values(obj)) walk(value)
  }
  walk(conversation)
  return out
}

export function findUserMessageId(conversation: unknown): string | undefined {
  const users = extractMessages(conversation).filter((m) => USER_TYPES.has(m.type))
  return users[users.length - 1]?.sId
}

export function findAgentMessageId(
  conversation: unknown,
  userMessageId?: string,
): string | undefined {
  const agents = extractMessages(conversation).filter((m) =>
    AGENT_TYPES.has(m.type),
  )
  if (userMessageId) {
    const match = agents.find((m) => m.parentMessageId === userMessageId)
    if (match) return match.sId
  }
  return agents[agents.length - 1]?.sId
}

export function findConversationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const obj = payload as Record<string, any>
  const conv = obj.conversation ?? obj
  if (conv && typeof conv.sId === 'string') return conv.sId
  if (typeof obj.conversation_id === 'string') return obj.conversation_id
  if (typeof obj.conversationId === 'string') return obj.conversationId
  return undefined
}

export function findSid(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, any>
  if (typeof obj.sId === 'string') return obj.sId
  if (typeof obj.message?.sId === 'string') return obj.message.sId
  if (typeof obj.message === 'string') return obj.message
  const seen = new Set<unknown>()
  const walk = (node: unknown): string | undefined => {
    if (!node || typeof node !== 'object' || seen.has(node)) return undefined
    seen.add(node)
    const o = node as Record<string, any>
    if (typeof o.sId === 'string') return o.sId
    if (Array.isArray(o)) {
      for (const item of o) {
        const found = walk(item)
        if (found) return found
      }
      return undefined
    }
    for (const value of Object.values(o)) {
      const found = walk(value)
      if (found) return found
    }
    return undefined
  }
  return walk(data)
}

export function extractAgentText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, any>
  if (typeof obj.message?.content === 'string') return obj.message.content
  if (typeof obj.content === 'string') return obj.content
  return undefined
}
