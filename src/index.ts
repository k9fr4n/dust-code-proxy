import { loadConfig, loadModelMapping } from './config.js'
import { CredentialStore } from './auth/credentials.js'
import { DustClient } from './dust/client.js'
import { ModelRouter } from './models.js'
import { SessionStore } from './sessions.js'
import { buildServer } from './server.js'
import { login, logout } from './cli.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const command = process.argv[2] ?? 'serve'

  if (command === 'login') {
    const force = process.argv.includes('--force')
    const wsIdx = process.argv.indexOf('--workspace')
    const workspace = wsIdx >= 0 ? process.argv[wsIdx + 1] : undefined
    await login(config, { force, workspace })
    return
  }
  if (command === 'logout') {
    await logout(config)
    return
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
