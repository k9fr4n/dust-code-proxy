import Fastify, { FastifyInstance } from 'fastify'
import { ServerContext } from './context.js'
import { ProxyError, anthropicErrorBody } from './errors.js'
import { buildMessagesHandler } from './anthropic/messages.js'
import { registerAdminRoutes } from './admin.js'
import { LOGIN_HINT } from './dust/client.js'

export function buildServer(ctx: ServerContext): FastifyInstance {
  const app = Fastify({
    logger: { level: ctx.config.logLevel },
    bodyLimit: 32 * 1024 * 1024,
  })

  ctx.logger = app.log
  ctx.dust.logger = app.log

  app.setErrorHandler((err: any, request, reply) => {
    if (err instanceof ProxyError) {
      reply.status(err.status).send(anthropicErrorBody(err.type, err.message))
      return
    }
    if (err?.validation || err?.statusCode === 400) {
      reply
        .status(400)
        .send(anthropicErrorBody('invalid_request_error', err?.message ?? 'Invalid request.'))
      return
    }
    request.log.error({ err }, 'Unhandled error')
    reply
      .status(err?.statusCode ?? 500)
      .send(anthropicErrorBody('api_error', err?.message ?? 'Internal proxy error.'))
  })

  app.get('/health', async () => {
    const dustAuth = ctx.dust.isAuthenticated ? 'ok' : 'missing'
    return {
      status: 'ok',
      dust_auth: dustAuth,
      ...(dustAuth === 'missing' ? { hint: LOGIN_HINT } : {}),
    }
  })

  app.get('/health/dust', async () => {
    if (!ctx.dust.isAuthenticated) {
      return {
        dust_auth: 'missing',
        hint: LOGIN_HINT,
      }
    }
    const ttl = ctx.dust.tokenTtlSeconds()
    return {
      dust_auth: ttl > 30 ? 'ok' : 'expiring',
      token_ttl_seconds: ttl,
      workspace: ctx.dust.workspaceId(),
    }
  })

  app.post('/v1/messages', buildMessagesHandler(ctx))

  app.get('/v1/models', async () => {
    if (ctx.dust.isAuthenticated) {
      try {
        ctx.router.setAgents(await ctx.dust.listRoutingAgents())
      } catch (err) {
        app.log.warn({ err }, 'Failed to refresh Dust agents for /v1/models')
      }
    }
    // The Dust provider catalog only — the same list as `proxyctl models`. Agent
    // names/sIds and models.json aliases are deliberately omitted: gateway
    // discovery would render them as "From gateway" rows that aren't real models.
    const data: { id: string; object: string; type: string; display_name?: string; description?: string }[] = []
    if (ctx.dust.isAuthenticated) {
      try {
        const catalog = await ctx.dust.modelCatalog()
        for (const m of catalog.models) {
          if (m.isSelectable === false) continue
          data.push({
            id: m.modelId,
            object: 'model',
            type: 'model',
            display_name: m.displayName,
            description: m.description,
          })
        }
      } catch (err) {
        app.log.warn({ err }, 'Failed to load Dust model catalog for /v1/models')
      }
    }
    return {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    }
  })

  // Internal session management — gated by INTERNAL_TOKEN.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/internal')) return
    const token = request.headers['x-internal-token']
    if (ctx.config.internalToken && token === ctx.config.internalToken) return
    reply
      .code(403)
      .send(anthropicErrorBody('permission_error', 'Internal endpoint requires a valid x-internal-token.'))
  })

  app.post('/internal/sessions', async (request, reply) => {
    const body = request.body as { session?: unknown } | undefined
    const key = body?.session
    if (typeof key !== 'string' || !key) {
      return reply
        .code(400)
        .send(anthropicErrorBody('invalid_request_error', 'Missing "session" key.'))
    }
    const existing = ctx.sessions.get(key)
    if (existing) {
      return { session: key, conversation_id: existing.conversationId ?? null, exists: true }
    }
    const session = ctx.sessions.create(key, 'internal', ctx.dust.workspaceId())
    return { session: key, conversation_id: session.conversationId ?? null, exists: false }
  })

  app.delete('/internal/sessions/:id', async (request) => {
    const id = (request.params as { id: string }).id
    ctx.sessions.delete(id)
    return { ok: true }
  })

  registerAdminRoutes(app, ctx)

  return app
}
