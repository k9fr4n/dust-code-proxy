import { loadConfig, loadModelMapping } from './config.js'
import { CredentialStore } from './auth/credentials.js'
import { ensureInternalToken } from './auth/internal-token.js'
import { DustClient } from './dust/client.js'
import { ModelRouter } from './models.js'
import { SessionStore } from './sessions.js'
import { buildServer } from './server.js'
import {
  CommandError,
  CommandOptions,
  agents,
  credits,
  login,
  logout,
  models,
  status,
} from './cli.js'

const USAGE = `dust-code-proxy <command>

Commands:
  serve                  Run the proxy (default).
  login [--force]        Log in to Dust on the running proxy (device-code flow).
         [--workspace ID]
  logout                 Clear the credentials of the running proxy.
  status                 Show proxy + Dust authentication status.
  credits                Show the fair-use credit limit, usage and balance.
  models [--all]         List the LLMs available in the Dust workspace.
  agents [--all]         List the Dust agents (routing targets of models.json).

Options:
  --json                 Print the raw JSON payload (status, credits, logout,
                         models, agents).
  --all                  models: include the models Dust marks as not
                         selectable for this workspace.
                         agents: include the archived agents.

The admin commands talk to the running container over /internal, so run them with:
  docker compose exec proxy proxyctl <command>
`

function parseOptions(argv: string[]): CommandOptions {
  const wsIdx = argv.indexOf('--workspace')
  return {
    force: argv.includes('--force'),
    all: argv.includes('--all'),
    workspace: wsIdx >= 0 ? argv[wsIdx + 1] : undefined,
    json: argv.includes('--json'),
  }
}

// Expected command failures print a single line; unexpected ones keep their
// stack so a real bug stays debuggable.
async function runCommand(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (err) {
    if (err instanceof CommandError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'serve'
  const opts = parseOptions(argv)

  switch (command) {
    case 'login':
      await runCommand(() => login(config, opts))
      return
    case 'logout':
      await runCommand(() => logout(config, opts))
      return
    case 'status':
      await runCommand(() => status(config, opts))
      return
    case 'credits':
      await runCommand(() => credits(config, opts))
      return
    case 'models':
      await runCommand(() => models(config, opts))
      return
    case 'agents':
      await runCommand(() => agents(config, opts))
      return
    case 'serve':
      break
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`)
      process.exit(1)
  }

  // The admin endpoints are gated by a shared secret. When INTERNAL_TOKEN is not
  // configured, generate one in the credentials volume so commands exec'd into
  // this container can authenticate without any manual setup.
  if (!config.internalToken) {
    try {
      config.internalToken = await ensureInternalToken(config.internalTokenFile)
    } catch (err) {
      console.error(
        `Could not provision the internal admin token (${(err as Error).message}). ` +
          'The /internal endpoints will stay disabled.',
      )
    }
  }

  const store = new CredentialStore(config.dustCredentialFile)
  const dust = new DustClient(config, store)
  await dust.init()

  const router = new ModelRouter(
    loadModelMapping(config.modelsFile),
    config.dustDefaultAgentConfigurationId,
  )
  const sessions = new SessionStore()
  const app = buildServer({ config, dust, router, sessions })

  // Best-effort agent list refresh + mapping validation after startup.
  void (async () => {
    if (!dust.isAuthenticated) return
    try {
      const agents = await dust.listAgents()
      router.setAgents(agents)
      const missing = router.missingMappedIds()
      if (missing.length) {
        app.log.warn({ missing }, 'Some mapped Dust agents are missing from the workspace')
      }
    } catch (err) {
      app.log.warn({ err }, 'Could not refresh Dust agent list at startup')
    }
  })()

  const shutdown = async () => {
    app.log.info('Shutting down...')
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await app.listen({ port: config.port, host: '0.0.0.0' })
  app.log.info(`dust-code-proxy listening on :${config.port}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
