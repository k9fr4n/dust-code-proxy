import { FastifyBaseLogger } from 'fastify'
import { Config } from './config.js'
import { DustClient } from './dust/client.js'
import { ModelRouter } from './models.js'
import { SessionStore } from './sessions.js'

export interface ServerContext {
  config: Config
  dust: DustClient
  router: ModelRouter
  sessions: SessionStore
  // Set by `buildServer`. Session-scoped components (the MCP bridge) outlive a
  // single request, so they log here rather than on a request logger.
  logger?: FastifyBaseLogger
}
