import { randomBytes } from 'node:crypto'
import { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { ServerContext } from '../context.js'
import { ProxyError } from '../errors.js'
import { Session } from '../sessions.js'
import {
  StreamTranslator,
  serializeSse,
  isTerminalDustEvent,
} from './stream.js'

interface ContentBlock {
  type: string
  text?: string
}

const contentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.string() }).passthrough(),
])

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
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
    metadata: z.record(z.unknown()).optional(),
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
): Promise<{ conversationId: string; agentMessageId: string }> {
  let conversationId = session.conversationId
  let agentMessageId: string | undefined
  let userMessageId: string | undefined

  if (!conversationId) {
    const result = await ctx.dust.createConversation(title, {
      content,
      agentConfigurationId: configurationId,
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
    })
    agentMessageId = result.agentMessageId
    userMessageId = result.userMessageId
  }

  if (!agentMessageId) {
    agentMessageId = await ctx.dust.resolveAgentMessageId(conversationId, userMessageId)
  }
  return { conversationId, agentMessageId }
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
): Promise<void> {
  const { conversationId, agentMessageId } = await prepareMessage(
    ctx,
    session,
    configurationId,
    content,
    title,
  )
  const messageId = randomId('msg')

  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const abort = new AbortController()
  const onClose = () => abort.abort()
  request.raw.on('close', onClose)

  const translator = new StreamTranslator(messageId, model)
  let interrupted = false
  try {
    for await (const event of ctx.dust.streamMessageEvents(conversationId, agentMessageId, {
      signal: abort.signal,
    })) {
      if (event.kind === 'done') break
      if (event.kind !== 'event') continue
      const frames = translator.translate(event)
      for (const frame of frames) reply.raw.write(serializeSse(frame))
      if (isTerminalDustEvent(event.type)) break
    }
    if (!translator.isFinished()) {
      for (const frame of translator.finishExternally()) {
        reply.raw.write(serializeSse(frame))
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      interrupted = true
      // Client disconnected: cancel the Dust generation.
      await ctx.dust.cancel(conversationId).catch(() => {})
    } else {
      for (const frame of translator.error((err as Error).message ?? 'Stream error')) {
        reply.raw.write(serializeSse(frame))
      }
    }
  } finally {
    request.raw.off('close', onClose)
    if (interrupted) {
      request.raw.destroy()
    } else {
      reply.raw.end()
    }
  }
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
    translator.translate(event)
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
    if (ctx.config.dustForwardSystem && body.system) {
      content = `[System instructions]\n${extractText(body.system)}\n\n[Claude Code request]\n${userText}`
    }

    const sessionKey = resolveSessionKey(request, body)
    let session = ctx.sessions.get(sessionKey)
    if (!session) {
      session = ctx.sessions.create(sessionKey, apiKey, ctx.dust.workspaceId())
    }
    ctx.sessions.touch(session)

    const title = userText.slice(0, 80) || 'Claude Code request'
    const stream = body.stream === true

    if (stream) {
      await handleStream(ctx, request, reply, body.model, configurationId, content, title, session)
    } else {
      await handleNonStream(ctx, reply, body.model, configurationId, content, title, session)
    }
  }
}
