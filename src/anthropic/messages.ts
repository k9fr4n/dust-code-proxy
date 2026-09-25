import { randomBytes } from 'node:crypto'
import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { LOGIN_HINT } from '../dust/client.js'
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

// Window in which the MCP bridge collects back-to-back `tools/call` events before
// ending the turn with `stop_reason: tool_use`. Dust dispatches parallel tools
// within milliseconds; this lets every `tool_use` block reach Claude Code instead
// of dropping all but the first.
const TOOL_USE_FLUSH_DELAY_MS = 200

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n')
}

// Claude Code sends a hidden "name this session" request before the first real
// turn. It carries a distinctive system prompt; detect it so it can be answered
// locally instead of creating a Dust conversation and burning an agent turn.
function isNamingRequest(body: MessagesRequest): boolean {
  if (!body.system) return false
  return extractText(body.system).includes('naming a coding session')
}

// Derive a session title from the naming request's content, which wraps the
// conversation so far in a `<session>…</session>` block. The exact wording is not
// critical — it is only a label in the session list.
function sessionTitleFrom(content: string): string {
  const match = content.match(/<session>([\s\S]*?)<\/session>/)
  const source = match ? match[1] : content
  const cleaned = source.replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 80) || 'Claude Code session'
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

  let toolUseFlushTimer: NodeJS.Timeout | null = null
  const flushToolUse = () => {
    if (toolUseFlushTimer) {
      clearTimeout(toolUseFlushTimer)
      toolUseFlushTimer = null
    }
    for (const frame of translator.finishToolUse()) {
      reply.raw.write(serializeSse(frame))
    }
    toolUseEnded = true
    // Stop reading the message events stream: the agent is now waiting on the
    // tool result(s). Do NOT cancel — the tool-result turn resumes this stream.
    disconnect.abort()
  }

  bridge?.setEmitter({
    emitToolUse(toolUseId, name, input) {
      for (const frame of translator.emitToolUseBlock(toolUseId, name, input)) {
        reply.raw.write(serializeSse(frame))
      }
      // Debounce the turn-ending `stop_reason: tool_use` so that all of a batch of
      // parallel tool calls are emitted before the response closes.
      if (toolUseFlushTimer) clearTimeout(toolUseFlushTimer)
      toolUseFlushTimer = setTimeout(flushToolUse, TOOL_USE_FLUSH_DELAY_MS)
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
    if (toolUseFlushTimer) clearTimeout(toolUseFlushTimer)
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

// Resume a parked Dust generation without streaming, collecting the assistant's
// answer (and any further tool calls) into a single JSON `message`. This is the
// non-streaming counterpart of `streamTurn`: Claude Code sends a tool_result
// continuation with `stream: false` when retrying after a stalled streaming resume.
async function collectTurn(
  ctx: ServerContext,
  model: string,
  conversationId: string,
  agentMessageId: string,
  session: Session,
  resumeLastEventId?: string,
): Promise<{ id: string; content: Record<string, unknown>[]; stopReason: string }> {
  const messageId = randomId('msg')
  const translator = new StreamTranslator(messageId, model)
  const bridge = session.mcp as SessionMcp | undefined
  const disconnect = new AbortController()
  let toolUseEnded = false

  let toolUseFlushTimer: NodeJS.Timeout | null = null
  const flushToolUse = () => {
    if (toolUseFlushTimer) {
      clearTimeout(toolUseFlushTimer)
      toolUseFlushTimer = null
    }
    translator.finishToolUse()
    toolUseEnded = true
    // Stop reading the message events stream: the agent is now waiting on the next
    // tool result. Do NOT cancel — the next tool-result turn resumes this stream.
    disconnect.abort()
  }

  bridge?.setEmitter({
    emitToolUse(toolUseId, name, input) {
      translator.emitToolUseBlock(toolUseId, name, input)
      if (toolUseFlushTimer) clearTimeout(toolUseFlushTimer)
      toolUseFlushTimer = setTimeout(flushToolUse, TOOL_USE_FLUSH_DELAY_MS)
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

      if (event.type === 'tool_approve_execution') {
        const actionId = event.data.actionId
        const messageId = event.data.messageId
        if (typeof actionId === 'string' && typeof messageId === 'string') {
          await ctx.dust.validateAction(conversationId, messageId, actionId, 'approved')
        }
        continue
      }

      translator.translate(event.data)
      if (translator.isFinished()) break
      if (isTerminalDustEvent(event.type)) break
    }
    if (!translator.isFinished()) translator.finishExternally()
  } catch (err) {
    if (toolUseEnded || disconnect.signal.aborted) {
      // Ended by tool_use (parked) or an external abort.
    } else if (err instanceof ProxyError) {
      throw err
    } else {
      throw new ProxyError('api_error', (err as Error).message ?? 'Stream error', 502)
    }
  } finally {
    if (toolUseFlushTimer) clearTimeout(toolUseFlushTimer)
    bridge?.setEmitter(null)
  }

  if (translator.errored) {
    throw new ProxyError('api_error', translator.errorMessage, 502)
  }

  const content: Record<string, unknown>[] = []
  if (translator.text) content.push({ type: 'text', text: translator.text })
  for (const toolUse of translator.toolUses) {
    content.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input })
  }
  return { id: messageId, content, stopReason: translator.stopReason ?? 'end_turn' }
}

// Answer Claude Code's hidden "name this session" request without a Dust round-trip.
// The title is the only thing it needs, so stream (or return) a single JSON title
// as a normal assistant message.
async function replySessionTitle(
  reply: FastifyReply,
  model: string,
  title: string,
  stream: boolean,
): Promise<void> {
  const messageId = randomId('msg')
  const text = JSON.stringify({ title })
  if (!stream) {
    reply.send({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    return
  }
  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const translator = new StreamTranslator(messageId, model)
  for (const frame of translator.translate({
    type: 'agent_message_success',
    message: { content: text },
  })) {
    reply.raw.write(serializeSse(frame))
  }
  reply.raw.end()
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
        LOGIN_HINT,
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

    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
    if (!lastUser) {
      throw new ProxyError('invalid_request_error', 'No user message found in the request.', 400)
    }

    // Claude Code's hidden "name this session" request is not a real user turn:
    // answer it locally so it neither creates a Dust conversation nor consumes an
    // agent turn (previously it opened the conversation and generated the title).
    if (isNamingRequest(body)) {
      await replySessionTitle(
        reply,
        body.model,
        sessionTitleFrom(extractText(lastUser.content)),
        body.stream === true,
      )
      return
    }

    const configurationId = ctx.router.resolve(body.model)

    const sessionKey = resolveSessionKey(request, body)
    let session = ctx.sessions.get(sessionKey)
    if (!session) {
      session = ctx.sessions.create(sessionKey, apiKey, ctx.dust.workspaceId())
    }
    ctx.sessions.touch(session)

    const toolResults = extractToolResults(lastUser.content)

    if (toolResults.length > 0) {
      // Tool-result turn: deliver the parked tool result(s) back to Dust, then resume
      // the parked generation from where the previous turn ended — no new user
      // message. Streaming *and* non-streaming resumes are supported: Claude Code
      // retries a stalled resume with `stream: false`, which must not be rejected.
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
        const outcome = await bridge.resolveToolResult(
          tr.tool_use_id,
          tr.content,
          tr.is_error === true,
        )
        if (outcome.status === 'failed') {
          throw new ProxyError(
            'api_error',
            `Failed to deliver tool result to Dust: ${outcome.error}`,
            502,
          )
        }
        // `unknown` (no parked call matches this id) means the history was replayed
        // or a prior attempt already consumed the call; resume on a best-effort basis.
        request.log.debug(
          { toolUseId: tr.tool_use_id, status: outcome.status },
          'tool_result processed for parked Dust tool call',
        )
      }
      if (body.stream === true) {
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
      } else {
        const result = await collectTurn(
          ctx,
          body.model,
          session.conversationId,
          session.agentMessageId,
          session,
          session.lastEventId,
        )
        reply.send({
          id: result.id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: result.content,
          stop_reason: result.stopReason,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      }
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
      // The `system` field is the large, static Claude Code prompt, and Claude Code
      // re-sends it verbatim on every turn — forwarding it each time duplicates the
      // whole prompt on every Dust user message. Send it only when the conversation
      // is first created; the per-turn inline `system` messages (git status,
      // environment, …) are still forwarded below.
      const systemParts: string[] = []
      if (body.system && !session.conversationId) systemParts.push(extractText(body.system))
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
