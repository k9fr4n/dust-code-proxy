import { createRequire } from 'node:module'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ServerContext } from './context.js'
import { anthropicErrorBody } from './errors.js'
import { LoginFlowStore, LoginStep } from './auth/login-flow.js'
import { LOGIN_HINT } from './dust/client.js'

// Admin endpoints backing the `login`, `logout`, `status` and `credits`
// commands. They all act on the *running* server instance: credentials are
// swapped in memory and the agent list is refreshed, so no restart is needed
// after a login or a logout.
//
// All of these live under /internal and are gated by the x-internal-token hook
// registered in server.ts.

const require = createRequire(import.meta.url)
const packageJson = (() => {
  try {
    return require('../package.json') as { version?: string }
  } catch {
    return {}
  }
})()

const startedAt = Date.now()

const startBody = z.object({ force: z.boolean().optional() })
const pollBody = z.object({ flow: z.string().min(1) })
const workspaceBody = z.object({
  flow: z.string().min(1),
  workspace: z.string().min(1),
})

export function registerAdminRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const flows = new LoginFlowStore(ctx.config.dustOAuthClientId)

  const refreshAgents = async (): Promise<number | null> => {
    try {
      const agents = await ctx.dust.listAgents()
      ctx.router.setAgents(agents)
      const missing = ctx.router.missingMappedIds()
      if (missing.length) {
        app.log.warn({ missing }, 'Some mapped Dust agents are missing from the workspace')
      }
      return agents.length
    } catch (err) {
      app.log.warn({ err }, 'Could not refresh the Dust agent list')
      return null
    }
  }

  const dropAllSessions = (): void => {
    for (const session of ctx.sessions.list()) ctx.sessions.delete(session.key)
  }

  app.get('/internal/status', async () => {
    // Pick up credentials a sibling process may have written since startup.
    if (!ctx.dust.isAuthenticated) await ctx.dust.reload()
    const info = ctx.dust.info()
    if (!info) {
      return { proxy: proxyStatus(ctx), dust_auth: 'missing', hint: LOGIN_HINT }
    }
    return {
      proxy: proxyStatus(ctx),
      dust_auth: info.tokenTtlSeconds > 30 ? 'ok' : 'expiring',
      workspace: info.workspaceSid,
      region: info.region,
      user: {
        username: info.username ?? null,
        full_name: info.fullName ?? null,
        email: info.email ?? null,
      },
      token_ttl_seconds: info.tokenTtlSeconds,
      credentials_updated_at: info.updatedAt,
    }
  })

  app.get('/internal/credits', async (_request, reply) => {
    if (!ctx.dust.isAuthenticated) await ctx.dust.reload()
    if (!ctx.dust.isAuthenticated) {
      return reply.code(401).send(anthropicErrorBody('authentication_error', LOGIN_HINT))
    }
    const credits = await ctx.dust.credits()
    return {
      workspace: ctx.dust.workspaceId(),
      source: credits.source,
      plan: credits.plan ?? null,
      allowance: credits.allowance ?? null,
      used: credits.used ?? null,
      remaining: credits.remaining ?? null,
      period_start: credits.periodStart ?? null,
      period_end: credits.periodEnd ?? null,
    }
  })

  app.post('/internal/logout', async () => {
    const info = ctx.dust.info()
    await ctx.dust.clearCredentials()
    ctx.router.setAgents([])
    dropAllSessions()
    return {
      ok: true,
      was_logged_in: info !== null,
      workspace: info?.workspaceSid ?? null,
    }
  })

  app.post('/internal/login/start', async (request, reply) => {
    const parsed = startBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(anthropicErrorBody('invalid_request_error', 'Invalid body.'))
    }
    if (!ctx.dust.isAuthenticated) await ctx.dust.reload()
    const info = ctx.dust.info()
    if (info && !parsed.data.force) {
      return {
        status: 'already_logged_in',
        workspace: info.workspaceSid,
        email: info.email ?? null,
      }
    }
    return { status: 'started', ...(await flows.start()) }
  })

  app.post('/internal/login/poll', async (request, reply) => {
    const parsed = pollBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(anthropicErrorBody('invalid_request_error', 'Missing "flow".'))
    }
    return finalize(await flows.poll(parsed.data.flow))
  })

  app.post('/internal/login/workspace', async (request, reply) => {
    const parsed = workspaceBody.safeParse(request.body)
    if (!parsed.success) {
      return reply
        .code(400)
        .send(anthropicErrorBody('invalid_request_error', 'Missing "flow" or "workspace".'))
    }
    return finalize(flows.selectWorkspace(parsed.data.flow, parsed.data.workspace))
  })

  // Installs the credentials in the live client when the flow completes. The
  // tokens themselves are never returned to the caller.
  async function finalize(step: LoginStep): Promise<Record<string, unknown>> {
    switch (step.status) {
      case 'pending':
        return { status: 'pending', interval: step.interval }
      case 'expired':
        return { status: 'expired' }
      case 'error':
        return { status: 'error', message: step.message }
      case 'select_workspace':
        return {
          status: 'select_workspace',
          workspaces: step.workspaces.map((w) => ({
            sId: w.sId,
            name: w.name,
            role: w.role ?? null,
          })),
        }
      case 'authorized': {
        await ctx.dust.setCredentials(step.credentials)
        dropAllSessions()
        return {
          status: 'authorized',
          workspace: step.credentials.workspaceSid,
          region: step.credentials.region,
          email: step.credentials.email ?? null,
          agents: await refreshAgents(),
        }
      }
    }
  }
}

function proxyStatus(ctx: ServerContext): Record<string, unknown> {
  return {
    version: packageJson.version ?? 'unknown',
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    port: ctx.config.port,
    models: ctx.router.listModels().length,
    sessions: ctx.sessions.list().length,
    default_agent: ctx.config.dustDefaultAgentConfigurationId ?? null,
  }
}
