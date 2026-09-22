import { randomBytes } from 'node:crypto'
import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ServerContext } from '../context.js'
import { ProxyError } from '../errors.js'
import { Session } from '../sessions.js'
import { SessionMcp } from '../mcp/bridge.js'
import {
  StreamTranslator,
  serializeSse,
  isTerminalDustEvent,
} from './stream.js'
import { AnthropicTool } from './tools.js'

interface ContentBlock {
  type: string
  text?: string
}

const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.string() }).passthrough(),
])

const messageSchema = z.object({
  // Claude Code injects `role: "system"` messages (system reminders, git status,
  // environment context) inside the `messages` array in addition to the top-level
  // `system` field. Accept them; their text is merged into the forwarded system
  // context in `handleMessages`.
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
})

const messagesRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    tools: z.array(z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

type MessagesRequest = z.infer<typeof messagesRequestSchema>

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

function hasUnsupportedBlocks(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false
  return content.some((block) => block.type !== 'text')
}

interface ToolResultBlock {
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

// A `tool_result` turn ends the current assistant message with the result(s) of the
// local tools Claude Code just ran. `content` is either the string result or an
// array of content blocks; we hand it through raw and let the bridge stringify it.
function extractToolResults(content: string | ContentBlock[]): ToolResultBlock[] {
  if (typeof content === 'string') return []
  const results: ToolResultBlock[] = []
  for (const block of content) {
    const b = block as unknown as Record<string, unknown>
    if (b.type !== 'tool_result') continue
    results.push({
      tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
      content: b.content,
      is_error: b.is_error === true,
    })
  }
  return results
}

// Coerce the free-form `tools[]` into the narrow shape the bridge needs. Anything
// that lacks a `name` is dropped; malformed `input_schema` falls back to `undefined`
// and the bridge's `jsonSchemaToZod` maps it to a loose record.
function parseTools(tools: unknown): AnthropicTool[] {
  if (!Array.isArray(tools)) return []
  const out: AnthropicTool[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    if (typeof o.name !== 'string') continue
    out.push({
      name: o.name,
      description: typeof o.description === 'string' ? o.description : undefined,
      input_schema:
        o.input_schema && typeof o.input_schema === 'object'
          ? (o.input_schema as Record<string, unknown>)
          : undefined,
    })
  }
  return out
}

function getApiKey(request: FastifyRequest): string | undefined {
  const xApiKey = request.headers['x-api-key']
  if (typeof xApiKey === 'string') return xApiKey
  const auth = request.headers['authorization']
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  return undefined
}

function resolveSessionKey(request: FastifyRequest, body: MessagesRequest): string {
  const header = request.headers['x-dust-session']
  if (typeof header === 'string' && header.trim()) return header.trim()
  const userId = body.metadata?.user_id
  if (typeof userId === 'string' && userId.trim()) return `meta:${userId}`
  const apiKey = getApiKey(request)
  return `key:${apiKey ?? 'unknown'}`
}

async function prepareMessage(
  ctx: ServerContext,
  session: Session,
  configurationId: string,
  content: string,
  title: string,
  clientSideMCPServerIds?: string[],
): Promise<{ conversationId: string; agentMessageId: string }> {
  let conversationId = session.conversationId
  let agentMessageId: string | undefined
  let userMessageId: string | undefined

  if (!conversationId) {
    const result = await ctx.dust.createConversation(title, {
      content,
      agentConfigurationId: configurationId,
      clientSideMCPServerIds,
    })
    conversationId = result.conversationId
    if (!conversationId) {
      throw new ProxyError('api_error', 'Dust did not return a conversation id.', 502)
    }
    session.conversationId = conversationId
    session.agentConfigurationId = configurationId
    agentMessageId = result.agentMessageId
    userMessageId = result.userMessageId
  } else {
    const result = await ctx.dust.postMessage(conversationId, {
      content,
      agentConfigurationId: configurationId,
      clientSideMCPServerIds,
    })
    agentMessageId = result.agentMessageId
    userMessageId = result.userMessageId
  }

  if (!agentMessageId) {
    agentMessageId = await ctx.dust.resolveAgentMessageId(conversationId, userMessageId)
  }

  // Persist the assistant message being streamed and reset the resume cursor: each
  // new user turn starts a fresh agent message.
  session.agentMessageId = agentMessageId
  session.lastEventId = undefined
  return { conversationId, agentMessageId }
}

// Start (or re-declare) the session's MCP bridge and return the live serverId, if
// any, to pass as `clientSideMCPServerIds` on the posted message.
async function ensureMcpBridge(
  ctx: ServerContext,
  session: Session,
  tools: AnthropicTool[],
): Promise<string[]> {
  if (tools.length === 0) return []
  let bridge = session.mcp as SessionMcp | undefined
  if (!bridge) {
    // Without a logger the transport's `onError` goes nowhere, so a bridge that
    // fails to register or relay produces no trace at all.
    bridge = new SessionMcp(ctx.dust, ctx.config, ctx.logger)
    session.mcp = bridge
  }
  await bridge.start(tools)
  return bridge.id ? [bridge.id] : []
}

// Stream a single turn to the client. The bridge (when present) is wired as the
// active emitter so a Dust `tools/call` becomes a `tool_use` block that ends this
// response with `stop_reason: tool_use` — while the Dust generation stays parked,
// awaiting the tool result (so it is *not* cancelled here).
async function streamTurn(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  model: string,
  conversationId: string,
  agentMessageId: string,
  session: Session,
  resumeLastEventId?: string,
): Promise<void> {
  const messageId = randomId('msg')

  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const disconnect = new AbortController()
  const onClose = () => disconnect.abort()
  // The request `close` event fires as soon as the body is consumed (before any
  // streaming), which aborts the turn immediately on the tool-result resume. The
  // socket `close` fires only on a real TCP disconnect.
  const socket = request.raw.socket
  socket.on('close', onClose)

  const translator = new StreamTranslator(messageId, model)
  const bridge = session.mcp as SessionMcp | undefined
  let toolUseEnded = false
  let interrupted = false

  bridge?.setEmitter({
    emitToolUse(toolUseId, name, input) {
      for (const frame of translator.emitToolUse(toolUseId, name, input)) {
        reply.raw.write(serializeSse(frame))
      }
      toolUseEnded = true
      // Stop reading the message events stream: the agent is now waiting on the
      // tool result. Do NOT cancel — the tool-result turn resumes this stream.
      disconnect.abort()
    },
  })

  try {
    for await (const event of ctx.dust.streamMessageEvents(conversationId, agentMessageId, {
      lastEventId: resumeLastEventId,
      signal: disconnect.signal,
    })) {
      if (event.kind === 'done') break
      if (event.kind !== 'event') continue
      if (event.eventId) session.lastEventId = event.eventId

      // A client-side MCP tool call first surfaces as a validation request. Approve
      // it so Dust dispatches `tools/call` to the bridge, which then emits `tool_use`.
      if (event.type === 'tool_approve_execution') {
        const actionId = event.data.actionId
        const messageId = event.data.messageId
        if (typeof actionId === 'string' && typeof messageId === 'string') {
          await ctx.dust.validateAction(conversationId, messageId, actionId, 'approved')
          request.log.info({ actionId }, 'Approved client-side MCP tool execution')
        } else {
          request.log.warn({ event: event.data }, 'tool_approve_execution missing ids')
        }
        continue
      }

      const frames = translator.translate(event.data)
      for (const frame of frames) reply.raw.write(serializeSse(frame))
      if (translator.isFinished()) break
      if (isTerminalDustEvent(event.type)) break
    }
    if (!translator.isFinished()) {
      for (const frame of translator.finishExternally()) {
        reply.raw.write(serializeSse(frame))
      }
    }
  } catch (err) {
    if (toolUseEnded) {
      // Ended by tool_use; the generation is parked, not cancelled.
    } else if (disconnect.signal.aborted) {
      interrupted = true
      // Client disconnected: cancel the Dust generation.
      request.log.info({ conversationId, agentMessageId }, 'Client disconnected; cancelling Dust generation')
      await ctx.dust
        .cancel(conversationId, agentMessageId)
        .catch((cancelErr) =>
          request.log.warn({ err: cancelErr }, 'Failed to cancel Dust generation'),
        )
    } else {
      for (const frame of translator.error((err as Error).message ?? 'Stream error')) {
        reply.raw.write(serializeSse(frame))
      }
    }
  } finally {
    bridge?.setEmitter(null)
    socket.off('close', onClose)
    if (interrupted) {
      request.raw.destroy()
    } else {
      reply.raw.end()
    }
  }
}

async function handleStream(
  ctx: ServerContext,
  request: FastifyRequest,
  reply: FastifyReply,
  model: string,
  configurationId: string,
  content: string,
  title: string,
  session: Session,
  tools: AnthropicTool[],
): Promise<void> {
  const serverIds = await ensureMcpBridge(ctx, session, tools)
  const { conversationId, agentMessageId } = await prepareMessage(
    ctx,
    session,
    configurationId,
    content,
    title,
    serverIds,
  )
  await streamTurn(ctx, request, reply, model, conversationId, agentMessageId, session)
}

async function handleNonStream(
  ctx: ServerContext,
  reply: FastifyReply,
  model: string,
  configurationId: string,
  content: string,
  title: string,
  session: Session,
): Promise<void> {
  const { conversationId, agentMessageId } = await prepareMessage(
    ctx,
    session,
    configurationId,
    content,
    title,
  )
  const messageId = randomId('msg')
  const translator = new StreamTranslator(messageId, model)
  for await (const event of ctx.dust.streamMessageEvents(conversationId, agentMessageId)) {
    if (event.kind === 'done') break
    if (event.kind !== 'event') continue
    if (event.eventId) session.lastEventId = event.eventId
    translator.translate(event.data)
    if (isTerminalDustEvent(event.type)) break
  }
  if (!translator.isFinished()) translator.finishExternally()
  if (translator.errored) {
    throw new ProxyError('api_error', translator.errorMessage, 502)
  }

  reply.send({
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content: translator.text ? [{ type: 'text', text: translator.text }] : [],
    stop_reason: translator.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  })
}

export function buildMessagesHandler(ctx: ServerContext) {
  return async function messagesHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const apiKey = getApiKey(request)
    if (!apiKey || !ctx.config.proxyApiKeys.includes(apiKey)) {
      throw new ProxyError('authentication_error', 'Invalid or missing proxy API key.', 401)
    }
    if (!ctx.dust.isAuthenticated) {
      throw new ProxyError(
        'authentication_error',
        'Not logged in to Dust. Run: docker compose run --rm proxy login',
        401,
      )
    }

    const parsed = messagesRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new ProxyError(
        'invalid_request_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      )
    }
    const body = parsed.data

    const configurationId = ctx.router.resolve(body.model)

    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) {
      throw new ProxyError('invalid_request_error', 'No user message found in the request.', 400)
    }

    const sessionKey = resolveSessionKey(request, body)
    let session = ctx.sessions.get(sessionKey)
    if (!session) {
      session = ctx.sessions.create(sessionKey, apiKey, ctx.dust.workspaceId())
    }
    ctx.sessions.touch(session)

    const toolResults = extractToolResults(lastUser.content)

    if (toolResults.length > 0) {
      // Tool-result turn: resolve the parked calls and resume the parked Dust
      // generation from where the previous turn ended — no new user message.
      if (body.stream !== true) {
        throw new ProxyError(
          'invalid_request_error',
          'Tool-result continuation requires streaming.',
          400,
        )
      }
      if (!session.conversationId || !session.agentMessageId) {
        throw new ProxyError(
          'invalid_request_error',
          'Tool result received without an active Dust conversation.',
          400,
        )
      }
      const bridge = session.mcp as SessionMcp | undefined
      if (!bridge) {
        throw new ProxyError(
          'invalid_request_error',
          'Tool result received without an active tool bridge.',
          400,
        )
      }
      for (const tr of toolResults) {
        if (!tr.tool_use_id) continue
        const matched = bridge.resolveToolResult(
          tr.tool_use_id,
          tr.content,
          tr.is_error === true,
        )
        request.log.debug(
          { toolUseId: tr.tool_use_id, matched },
          'tool_result received for parked Dust tool call',
        )
      }
      await streamTurn(
        ctx,
        request,
        reply,
        body.model,
        session.conversationId,
        session.agentMessageId,
        session,
        session.lastEventId,
      )
      return
    }

    if (hasUnsupportedBlocks(lastUser.content)) {
      throw new ProxyError(
        'invalid_request_error',
        'This MVP only supports text blocks. Tool use, images and documents are not supported yet.',
        400,
      )
    }
    const userText = extractText(lastUser.content)
    if (!userText.trim()) {
      throw new ProxyError('invalid_request_error', 'Empty user message.', 400)
    }

    let content = userText
    if (ctx.config.dustForwardSystem) {
      // Merge the top-level `system` field and any inline `system` messages so the
      // system reminders Claude Code sends as messages are not silently dropped.
      const systemParts: string[] = []
      if (body.system) systemParts.push(extractText(body.system))
      for (const m of body.messages) {
        if (m.role === 'system') {
          const text = extractText(m.content)
          if (text.trim()) systemParts.push(text)
        }
      }
      if (systemParts.length > 0) {
        content = `[System instructions]\n${systemParts.join('\n\n')}\n\n[Claude Code request]\n${userText}`
      }
    }

    const title = userText.slice(0, 80) || 'Claude Code request'
    const stream = body.stream === true

    if (stream) {
      const tools = parseTools(body.tools)
      await handleStream(
        ctx,
        request,
        reply,
        body.model,
        configurationId,
        content,
        title,
        session,
        tools,
      )
    } else {
      await handleNonStream(ctx, reply, body.model, configurationId, content, title, session)
    }
  }
}
