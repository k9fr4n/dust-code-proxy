import { Config } from '../config.js'
import { Credentials, CredentialStore } from '../auth/credentials.js'
import { decodeJwt, secondsUntilExpiry } from '../auth/jwt.js'
import { refreshTokens } from '../auth/oauth.js'
import { DustAuthError, ProxyError } from '../errors.js'
import {
  DustAgentConfig,
  MeInfo,
  parseMe,
  parseAgentConfigurations,
  findConversationId,
  findUserMessageId,
  findAgentMessageId,
  findSid,
} from './parse.js'
import { CREDITS_PATH, CreditsInfo, parseCredits } from './credits.js'
import { ParsedDustEvent, ParsedMcpRequest, streamSse, streamMcpRequests } from './sse.js'
import {
  registerMcpResponseSchema,
  heartbeatMcpResponseSchema,
  postMcpResultsResponseSchema,
} from './mcp.js'

export const LOGIN_HINT =
  'Not logged in to Dust. Run: docker compose exec proxy proxyctl login'

export interface PostMessageInput {
  content: string
  agentConfigurationId: string
  clientSideMCPServerIds?: string[]
}

export interface ConversationResult {
  conversationId?: string
  userMessageId?: string
  agentMessageId?: string
}

interface MessageContext {
  timezone: string
  username: string
  fullName: string
  email: string
  origin: string
  clientSideMCPServerIds: string[] | null
}

export class DustClient {
  private creds: Credentials | null = null
  private refreshInFlight: Promise<void> | null = null
  // Assigned by `buildServer`; stream-level failures happen outside any request.
  logger?: { warn?: (...args: unknown[]) => void }

  constructor(
    private readonly config: Config,
    private readonly store: CredentialStore,
  ) {}

  get isAuthenticated(): boolean {
    return this.creds !== null
  }

  async init(): Promise<void> {
    this.creds = await this.store.load()
  }

  // Re-read the credentials file. Used when a sibling process (an older
  // `docker compose run --rm proxy login`) wrote credentials the running server
  // has not picked up yet.
  async reload(): Promise<void> {
    this.creds = await this.store.load()
  }

  // Non-secret view of the current credentials, for `status`. Never exposes the
  // access or refresh token.
  info(): {
    workspaceSid: string
    region: string
    username?: string
    fullName?: string
    email?: string
    updatedAt: string
    tokenTtlSeconds: number
  } | null {
    if (!this.creds) return null
    return {
      workspaceSid: this.creds.workspaceSid,
      region: this.creds.region,
      username: this.creds.username,
      fullName: this.creds.fullName,
      email: this.creds.email,
      updatedAt: this.creds.updatedAt,
      tokenTtlSeconds: this.tokenTtlSeconds(),
    }
  }

  async setCredentials(creds: Credentials): Promise<void> {
    this.creds = creds
    await this.store.save(creds)
  }

  async clearCredentials(): Promise<void> {
    this.creds = null
    await this.store.clear()
  }

  workspaceId(): string {
    if (!this.creds) {
      throw new DustAuthError(
        LOGIN_HINT,
      )
    }
    return this.creds.workspaceSid
  }

  tokenTtlSeconds(): number {
    if (!this.creds) return 0
    return secondsUntilExpiry(this.creds.accessToken)
  }

  private baseUrl(): string {
    if (this.creds?.region === 'europe-west1') return 'https://eu.dust.tt'
    if (this.creds?.region === 'us-central1') return 'https://dust.tt'
    return this.config.dustBaseUrl
  }

  private async ensureFreshToken(): Promise<string> {
    if (!this.creds) {
      throw new DustAuthError(
        LOGIN_HINT,
      )
    }
    if (secondsUntilExpiry(this.creds.accessToken) > 30) {
      return this.creds.accessToken
    }
    await this.refresh()
    if (!this.creds) {
      throw new DustAuthError(
        `Dust token refresh failed. ${LOGIN_HINT}`,
      )
    }
    return this.creds.accessToken
  }

  private refresh(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null
      })
    }
    return this.refreshInFlight
  }

  private async doRefresh(): Promise<void> {
    if (!this.creds) return
    try {
      const tokens = await refreshTokens(
        this.config.dustOAuthClientId,
        this.creds.refreshToken,
      )
      const { region } = decodeJwt(tokens.accessToken)
      this.creds = {
        ...this.creds,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        region: region ?? this.creds.region,
        updatedAt: new Date().toISOString(),
      }
      await this.store.save(this.creds)
    } catch {
      // A failed refresh (revoked/expired) purges the tokens and flips the proxy
      // back to "unauthenticated" instead of looping forever.
      await this.store.clear()
      this.creds = null
    }
  }

  private messageContext(clientSideMCPServerIds?: string[]): MessageContext {
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      username: this.creds?.username ?? 'proxy',
      fullName: this.creds?.fullName ?? this.creds?.username ?? 'proxy',
      email: this.creds?.email ?? '',
      origin: 'claude-code-proxy',
      clientSideMCPServerIds: clientSideMCPServerIds ?? null,
    }
  }

  async request(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const token = await this.ensureFreshToken()
    const url = `${this.baseUrl()}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.config.timeouts.createMessageMs,
    )
    try {
      return await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  async me(): Promise<MeInfo> {
    const res = await this.request('/api/v1/me', {}, this.config.timeouts.createMessageMs)
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new ProxyError('api_error', `GET /api/v1/me failed (${res.status})`, 502)
    }
    return parseMe(json)
  }

  // Remaining credits. See `credits.ts` for why this uses a web-app endpoint
  // rather than the public API.
  async credits(): Promise<CreditsInfo> {
    const path = CREDITS_PATH.replace('{ws}', this.workspaceId())
    const res = await this.request(path, {}, this.config.timeouts.createMessageMs)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProxyError(
        'api_error',
        `Dust credit lookup failed (${res.status}): ${text.slice(0, 200)}`,
        502,
      )
    }
    const json = await res.json().catch(() => null)
    return parseCredits(json, `GET ${path}`)
  }

  async listAgents(): Promise<DustAgentConfig[]> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/agent_configurations`,
      {},
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new ProxyError(
        'api_error',
        `List agents failed (${res.status}): ${JSON.stringify(json)}`,
        502,
      )
    }
    return parseAgentConfigurations(json)
  }

  async createConversation(
    title: string,
    message: PostMessageInput,
  ): Promise<ConversationResult> {
    const ws = this.workspaceId()
    const body: Record<string, unknown> = {
      title,
      visibility: 'unlisted',
      message: {
        content: message.content,
        mentions: [{ configurationId: message.agentConfigurationId }],
        context: this.messageContext(message.clientSideMCPServerIds),
      },
      blocking: false,
      // Client-side MCP tools need the validation→approval round trip to resume
      // the agent generation after the tool result. Skipping it here parks the
      // loop at `blocked_validation_required` with nobody to approve, and forcing
      // `skipToolsValidation: true` makes the generation cancel after the result.
      // So leave the default and approve the `tool_approve_execution` event.
      skipToolsValidation: false,
    }
    // The Dust API rejects `null` for these optional fields (Zod: string/object/array
    // or undefined, never null). Omit them instead of sending `null`.
    if (this.config.dustSpaceId) {
      body.spaceId = this.config.dustSpaceId
    }
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/conversations`,
      { method: 'POST', body: JSON.stringify(body) },
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    return this.parseConversationResult(json)
  }

  async postMessage(
    conversationId: string,
    message: PostMessageInput,
  ): Promise<ConversationResult> {
    const ws = this.workspaceId()
    const body = {
      content: message.content,
      mentions: [{ configurationId: message.agentConfigurationId }],
      context: this.messageContext(message.clientSideMCPServerIds),
    }
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/conversations/${conversationId}/messages`,
      { method: 'POST', body: JSON.stringify(body) },
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    return this.parseConversationResult(json)
  }

  async getConversation(conversationId: string): Promise<unknown> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/conversations/${conversationId}`,
      {},
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    return json
  }

  private parseConversationResult(json: unknown): ConversationResult {
    const conversation = (json as Record<string, any>)?.conversation ?? json
    const conversationId = findConversationId(json)
    const userMessageId = findUserMessageId(conversation)
    const agentMessageId = findAgentMessageId(conversation, userMessageId)
    return { conversationId, userMessageId, agentMessageId }
  }

  // Two-step resolution: the POST may not yet return the assistant message id.
  // When it does not, subscribe to the conversation event stream, wait for
  // `user_message_new`/`user_message_promoted`, then refetch the conversation and
  // locate the `agent_message` whose parent is that user message.
  async resolveAgentMessageId(
    conversationId: string,
    knownUserMessageId?: string,
  ): Promise<string> {
    if (knownUserMessageId) {
      const conversation = await this.getConversation(conversationId)
      const agentId = findAgentMessageId(conversation, knownUserMessageId)
      if (agentId) return agentId
    }

    let userMessageId = knownUserMessageId
    for await (const event of this.streamConversationEvents(conversationId)) {
      if (event.kind === 'done') break
      if (event.kind !== 'event') continue
      if (event.type === 'user_message_new' || event.type === 'user_message_promoted') {
        userMessageId = findSid(event.data) ?? userMessageId
        break
      }
      if (event.type === 'user_message_error') {
        throw new ProxyError(
          'api_error',
          'Dust reported an error on the user message.',
          502,
        )
      }
      if (event.type === 'agent_error') break
    }

    const conversation = await this.getConversation(conversationId)
    const agentId = findAgentMessageId(conversation, userMessageId)
    if (!agentId) {
      throw new ProxyError(
        'api_error',
        'Could not resolve the Dust assistant message id. The agent mention was ' +
          'probably rejected: check that DUST_DEFAULT_AGENT_CONFIGURATION_ID (or the ' +
          'models.json entry) is a valid agent sId, not a display name.',
        502,
      )
    }
    return agentId
  }

  streamMessageEvents(
    conversationId: string,
    agentMessageId: string,
    opts?: { lastEventId?: string; signal?: AbortSignal },
  ): AsyncGenerator<ParsedDustEvent> {
    const ws = this.workspaceId()
    const qs = opts?.lastEventId
      ? `?lastEventId=${encodeURIComponent(opts.lastEventId)}`
      : ''
    const url = `${this.baseUrl()}/api/v1/w/${ws}/assistant/conversations/${conversationId}/messages/${agentMessageId}/events${qs}`
    return this.stream(url, opts)
  }

  streamConversationEvents(
    conversationId: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedDustEvent> {
    const ws = this.workspaceId()
    const url = `${this.baseUrl()}/api/v1/w/${ws}/assistant/conversations/${conversationId}/events`
    return this.stream(url, opts)
  }

  // A Dust generation can stall indefinitely (e.g. a tool call parked server-side),
  // leaving the client hanging on an open stream. `idleStreamMs` bounds the gap
  // between two events: when it elapses we abort the fetch and surface an error so
  // the caller can always emit a terminal frame.
  private async *stream(
    url: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedDustEvent> {
    const token = await this.ensureFreshToken()
    const idleMs = this.config.timeouts.idleStreamMs
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (opts?.signal?.aborted) controller.abort()
    else opts?.signal?.addEventListener('abort', onOuterAbort, { once: true })

    let idleTimer: NodeJS.Timeout | null = null
    let idleElapsed = false
    const armIdle = () => {
      if (idleMs <= 0) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleElapsed = true
        this.logger?.warn?.({ url, idleMs }, 'Dust stream idle timeout; aborting')
        controller.abort()
      }, idleMs)
    }

    try {
      armIdle()
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new ProxyError(
          'api_error',
          `Dust SSE stream failed (${res.status}): ${text.slice(0, 300)}`,
          502,
        )
      }
      for await (const event of streamSse(res.body, { signal: controller.signal })) {
        armIdle()
        yield event
      }
    } catch (err) {
      // Our own idle abort must not look like a caller-driven cancellation.
      if (idleElapsed && !opts?.signal?.aborted) {
        throw new ProxyError(
          'api_error',
          `No Dust event received for ${idleMs}ms; stream aborted.`,
          504,
        )
      }
      throw err
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      opts?.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  private async *streamMcp(
    url: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedMcpRequest> {
    const token = await this.ensureFreshToken()
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      signal: opts?.signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ProxyError(
        'api_error',
        `Dust MCP stream failed (${res.status}): ${text.slice(0, 300)}`,
        502,
      )
    }
    yield* streamMcpRequests(res.body, opts)
  }

  // Dust requires the agent messages to stop in the body; a bodyless POST is
  // rejected with 400 "Malformed JSON in request body". Errors are raised, not
  // swallowed, so the caller can log why a cancellation did not take effect.
  async cancel(conversationId: string, agentMessageId: string): Promise<void> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/conversations/${conversationId}/cancel`,
      { method: 'POST', body: JSON.stringify({ messageIds: [agentMessageId] }) },
      10000,
    )
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      throw this.mapDustError(res.status, json)
    }
  }

  // Approve (or reject) a pending tool execution. Client-side MCP tools arrive as
  // `blocked_validation_required` with a `tool_approve_execution` event; approving
  // is what resumes the agent loop and dispatches `tools/call` to our bridge.
  async validateAction(
    conversationId: string,
    messageId: string,
    actionId: string,
    approved: 'approved' | 'rejected' | 'always_approved',
  ): Promise<void> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/assistant/conversations/${conversationId}/messages/${messageId}/validate-action`,
      { method: 'POST', body: JSON.stringify({ actionId, approved }) },
      10000,
    )
    if (!res.ok) {
      const json = await res.json().catch(() => null)
      throw this.mapDustError(res.status, json)
    }
  }

  async registerMcpServer(
    serverName: string,
  ): Promise<{ serverId: string; expiresAt: string }> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/mcp/register`,
      { method: 'POST', body: JSON.stringify({ serverName }) },
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    const parsed = registerMcpResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new ProxyError(
        'api_error',
        `Unexpected mcp/register response: ${JSON.stringify(json)}`,
        502,
      )
    }
    return parsed.data
  }

  async heartbeatMcpServer(
    serverId: string,
  ): Promise<{ success: boolean; expiresAt: string }> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/mcp/heartbeat`,
      { method: 'POST', body: JSON.stringify({ serverId }) },
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    const parsed = heartbeatMcpResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new ProxyError(
        'api_error',
        `Unexpected mcp/heartbeat response: ${JSON.stringify(json)}`,
        502,
      )
    }
    return parsed.data
  }

  async postMcpResult(
    serverId: string,
    result: unknown,
  ): Promise<{ success: boolean }> {
    const ws = this.workspaceId()
    const res = await this.request(
      `/api/v1/w/${ws}/mcp/results`,
      { method: 'POST', body: JSON.stringify({ serverId, result }) },
      this.config.timeouts.createMessageMs,
    )
    const json = await res.json().catch(() => null)
    if (!res.ok) throw this.mapDustError(res.status, json)
    const parsed = postMcpResultsResponseSchema.safeParse(json)
    if (!parsed.success) {
      throw new ProxyError(
        'api_error',
        `Unexpected mcp/results response: ${JSON.stringify(json)}`,
        502,
      )
    }
    return parsed.data
  }

  streamMcpRequests(
    serverId: string,
    lastEventId?: string | null,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedMcpRequest> {
    const ws = this.workspaceId()
    const params = new URLSearchParams({ serverId })
    if (lastEventId) params.set('lastEventId', lastEventId)
    const url = `${this.baseUrl()}/api/v1/w/${ws}/mcp/requests?${params.toString()}`
    return this.streamMcp(url, opts)
  }

  private mapDustError(status: number, json: unknown): ProxyError {
    const obj = (json ?? {}) as Record<string, any>
    const raw = obj.error?.message ?? obj.error ?? obj.message ?? `Dust API error (${status})`
    const message = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (status === 401) return new ProxyError('authentication_error', message, 401)
    if (status === 403) return new ProxyError('permission_error', message, 403)
    if (status === 404) return new ProxyError('not_found_error', message, 404)
    if (status === 429) return new ProxyError('rate_limit_error', message, 429)
    if (status >= 500) return new ProxyError('api_error', message, 502)
    return new ProxyError('invalid_request_error', message, 400)
  }
}
