import { Config } from './config.js'
import { DustClient } from './dust/client.js'
import { ModelRouter } from './models.js'
import { SessionStore } from './sessions.js'

export interface ServerContext {
  config: Config
  dust: DustClient
  router: ModelRouter
  sessions: SessionStore
}
