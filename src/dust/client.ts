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
import { ParsedDustEvent, streamSse } from './sse.js'

export interface PostMessageInput {
  content: string
  agentConfigurationId: string
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
        'Not logged in to Dust. Run: docker compose run --rm proxy login',
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
        'Not logged in to Dust. Run: docker compose run --rm proxy login',
      )
    }
    if (secondsUntilExpiry(this.creds.accessToken) > 30) {
      return this.creds.accessToken
    }
    await this.refresh()
    if (!this.creds) {
      throw new DustAuthError(
        'Dust token refresh failed. Run: docker compose run --rm proxy login',
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

  private messageContext(): MessageContext {
    return {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      username: this.creds?.username ?? 'proxy',
      fullName: this.creds?.fullName ?? this.creds?.username ?? 'proxy',
      email: this.creds?.email ?? '',
      origin: 'claude-code-proxy',
      clientSideMCPServerIds: null,
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
    const body = {
      title,
      visibility: 'unlisted',
      message: {
        content: message.content,
        mentions: [{ configurationId: message.agentConfigurationId }],
        context: this.messageContext(),
      },
      contentFragment: null,
      contentFragments: null,
      blocking: false,
      skipToolsValidation: false,
      spaceId: this.config.dustSpaceId ?? null,
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
      context: this.messageContext(),
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
        'Could not resolve the Dust assistant message id.',
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

  private async *stream(
    url: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ParsedDustEvent> {
    const token = await this.ensureFreshToken()
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      signal: opts?.signal,
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new ProxyError(
        'api_error',
        `Dust SSE stream failed (${res.status}): ${text.slice(0, 300)}`,
        502,
      )
    }
    yield* streamSse(res.body, opts)
  }

  async cancel(conversationId: string): Promise<void> {
    const ws = this.workspaceId()
    try {
      await this.request(
        `/api/v1/w/${ws}/assistant/conversations/${conversationId}/cancel`,
        { method: 'POST' },
        10000,
      )
    } catch {
      // best-effort cancellation
    }
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
