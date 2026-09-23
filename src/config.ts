import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface TimeoutConfig {
  connectMs: number
  createMessageMs: number
  generationMs: number
  idleStreamMs: number
}

export interface Config {
  port: number
  logLevel: string
  proxyApiKeys: string[]
  internalToken: string | undefined
  internalTokenFile: string
  adminBaseUrl: string
  dustOAuthClientId: string
  dustCredentialFile: string
  dustBaseUrl: string
  dustSpaceId: string | undefined
  dustDefaultAgentConfigurationId: string | undefined
  dustForwardSystem: boolean
  modelsFile: string
  mcpServerName: string
  mcpHeartbeatIntervalMs: number
  mcpReconnectDelayMs: number
  timeouts: TimeoutConfig
}

export interface ModelMapping {
  [modelName: string]: { configurationId: string }
}

function intValue(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === 'true' || value === '1'
}

function listValue(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intValue(env.PORT, 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    proxyApiKeys: listValue(env.PROXY_API_KEYS),
    internalToken: env.INTERNAL_TOKEN || undefined,
    internalTokenFile:
      env.INTERNAL_TOKEN_FILE ||
      join(dirname(env.DUST_CREDENTIAL_FILE ?? '/data/dust-credentials.json'), 'internal-token'),
    adminBaseUrl:
      env.PROXY_ADMIN_URL || `http://127.0.0.1:${intValue(env.PORT, 8080)}`,
    dustOAuthClientId:
      env.DUST_OAUTH_CLIENT_ID ?? 'client_01JGCT55T7FVDG9XF74925R1KT',
    dustCredentialFile: env.DUST_CREDENTIAL_FILE ?? '/data/dust-credentials.json',
    dustBaseUrl: env.DUST_BASE_URL ?? 'https://dust.tt',
    dustSpaceId: env.DUST_SPACE_ID || undefined,
    dustDefaultAgentConfigurationId:
      env.DUST_DEFAULT_AGENT_CONFIGURATION_ID || undefined,
    dustForwardSystem: boolValue(env.DUST_FORWARD_SYSTEM, true),
    modelsFile: env.MODELS_FILE ?? './models.json',
    mcpServerName: env.DUST_MCP_SERVER_NAME ?? 'claude-code-proxy',
    mcpHeartbeatIntervalMs: intValue(env.DUST_MCP_HEARTBEAT_INTERVAL_MS, 4 * 60 * 1000),
    mcpReconnectDelayMs: intValue(env.DUST_MCP_RECONNECT_DELAY_MS, 5 * 1000),
    timeouts: {
      connectMs: intValue(env.DUST_CONNECT_TIMEOUT_MS, 10000),
      createMessageMs: intValue(env.DUST_CREATE_MESSAGE_TIMEOUT_MS, 30000),
      generationMs: intValue(env.DUST_GENERATION_TIMEOUT_MS, 900000),
      idleStreamMs: intValue(env.DUST_IDLE_STREAM_TIMEOUT_MS, 120000),
    },
  }
}

export function loadModelMapping(file: string): ModelMapping {
  try {
    const raw = readFileSync(resolve(file), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ModelMapping
    }
    return {}
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return {}
    throw new Error(`Failed to parse model mapping file "${file}": ${e.message}`)
  }
}
