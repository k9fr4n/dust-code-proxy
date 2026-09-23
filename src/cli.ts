import { createInterface } from 'node:readline'
import { Config } from './config.js'
import { CredentialStore } from './auth/credentials.js'
import { readInternalToken } from './auth/internal-token.js'
import { secondsUntilExpiry } from './auth/jwt.js'

// The admin commands are thin clients over the proxy's /internal endpoints, so
// they act on the container that is *already running*:
//
//   docker compose exec proxy proxyctl login
//
// Running them in a throwaway container (`docker compose run --rm`) would write
// the credentials file without the live server ever re-reading it, leaving the
// proxy unauthenticated until a restart. Going through HTTP swaps the
// credentials in the running process instead.
//
// `status` and `logout` degrade gracefully to the local credentials file when
// the server is not reachable; `login` and `credits` need it.

export interface CommandOptions {
  force?: boolean
  workspace?: string
  json?: boolean
}

class ServerUnreachable extends Error {}

// A throwaway container (`docker compose run --rm proxy login`) has no server on
// 127.0.0.1, so the failure mode is the same as "proxy not started": point at the
// running container in both cases.
const UNREACHABLE_HINT =
  'Start it first (docker compose up -d), then run the command against the ' +
  'running container:\n  docker compose exec proxy proxyctl <command>'

// Expected failures (not logged in, bad token, …): reported as a single line
// without a stack trace.
export class CommandError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function resolveToken(config: Config): Promise<string> {
  const token = config.internalToken ?? (await readInternalToken(config.internalTokenFile))
  if (!token) {
    throw new CommandError(
      `No internal token found (looked at INTERNAL_TOKEN and ${config.internalTokenFile}).\n` +
        'Start the proxy once so it can generate one, or set INTERNAL_TOKEN on both sides.',
    )
  }
  return token
}

async function call(
  config: Config,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<any> {
  const token = await resolveToken(config)
  const url = `${config.adminBaseUrl}${path}`
  const method = init.method ?? 'GET'
  // Fastify rejects an empty body when Content-Type is application/json, so a
  // POST without payload still sends `{}`.
  const body = method === 'GET' ? undefined : JSON.stringify(init.body ?? {})
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-internal-token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body,
    })
  } catch (err) {
    throw new ServerUnreachable(
      `Cannot reach the proxy at ${config.adminBaseUrl}: ${(err as Error).message}`,
    )
  }
  const json = (await res.json().catch(() => null)) as any
  if (res.status === 403) {
    throw new CommandError(
      'The proxy rejected the internal token. Make sure INTERNAL_TOKEN matches, ' +
        'or that both sides share the same credentials volume.',
    )
  }
  if (!res.ok) {
    throw new CommandError(
      json?.error?.message ?? json?.message ?? `${method} ${path} failed (HTTP ${res.status}).`,
    )
  }
  return json
}

function print(json: boolean, payload: unknown, lines: () => string[]): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  for (const line of lines()) console.log(line)
}

// --- login ------------------------------------------------------------------

export async function login(config: Config, opts: CommandOptions): Promise<void> {
  let started: any
  try {
    started = await call(config, '/internal/login/start', {
      method: 'POST',
      body: { force: opts.force ?? false },
    })
  } catch (err) {
    if (err instanceof ServerUnreachable) {
      throw new CommandError(`${err.message}\n${UNREACHABLE_HINT}`)
    }
    throw err
  }

  if (started.status === 'already_logged_in') {
    console.log(
      `Already logged in as ${started.email ?? 'unknown'} (workspace ${started.workspace}). ` +
        'Use --force to re-login.',
    )
    return
  }

  console.log('')
  console.log('To sign in, open this URL in your browser:')
  console.log(`  ${started.verificationUriComplete}`)
  console.log('')
  console.log(`Then enter this code if prompted: ${started.userCode}`)
  console.log('')
  console.log('Waiting for authorization...')

  const flow: string = started.flow
  let interval: number = started.interval ?? 5

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(interval * 1000)
    const step = await call(config, '/internal/login/poll', { method: 'POST', body: { flow } })

    if (step.status === 'pending') {
      interval = step.interval ?? interval
      continue
    }
    if (step.status === 'expired') {
      throw new CommandError('Authorization expired. Please run the login command again.')
    }
    if (step.status === 'error') {
      throw new CommandError(`Login error: ${step.message}`)
    }
    if (step.status === 'select_workspace') {
      const chosen = await chooseWorkspace(step.workspaces, opts.workspace)
      const final = await call(config, '/internal/login/workspace', {
        method: 'POST',
        body: { flow, workspace: chosen },
      })
      reportLogin(final)
      return
    }
    reportLogin(step)
    return
  }
}

async function chooseWorkspace(
  workspaces: { sId: string; name: string }[],
  preferred?: string,
): Promise<string> {
  if (preferred) {
    if (!workspaces.some((w) => w.sId === preferred)) {
      throw new CommandError(
        `Workspace "${preferred}" is not available for this account.`,
      )
    }
    return preferred
  }
  console.log('\nSelect a workspace:')
  workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name} (${w.sId})`))
  const answer = await prompt('Enter number: ')
  const chosen = workspaces[Number.parseInt(answer, 10) - 1]?.sId
  if (!chosen) throw new CommandError('Invalid selection.')
  return chosen
}

function reportLogin(step: any): void {
  if (step.status !== 'authorized') {
    throw new CommandError(`Unexpected login outcome: ${JSON.stringify(step)}`)
  }
  console.log(
    `\nLogged in as ${step.email ?? 'unknown'}, workspace "${step.workspace}" selected.`,
  )
  if (typeof step.agents === 'number') {
    console.log(`${step.agents} Dust agent(s) available for model routing.`)
  }
  console.log('The running proxy picked up the new credentials — no restart needed.')
}

// --- logout -----------------------------------------------------------------

export async function logout(config: Config, opts: CommandOptions = {}): Promise<void> {
  try {
    const result = await call(config, '/internal/logout', { method: 'POST' })
    print(opts.json ?? false, result, () => [
      result.was_logged_in
        ? `Logged out of workspace ${result.workspace}. The running proxy is now unauthenticated.`
        : 'Not logged in; nothing to do.',
    ])
  } catch (err) {
    if (!(err instanceof ServerUnreachable)) throw err
    // Proxy down: still clear the credentials on disk.
    const store = new CredentialStore(config.dustCredentialFile)
    await store.clear()
    console.log('Proxy not reachable; cleared the local credentials file instead.')
  }
}

// --- status -----------------------------------------------------------------

export async function status(config: Config, opts: CommandOptions = {}): Promise<void> {
  let result: any
  try {
    result = await call(config, '/internal/status')
  } catch (err) {
    if (!(err instanceof ServerUnreachable)) throw err
    await localStatus(config, opts)
    process.exitCode = 1
    return
  }

  print(opts.json ?? false, result, () => {
    const lines = [
      `proxy      : running (v${result.proxy.version}, up ${result.proxy.uptime_seconds}s, port ${result.proxy.port})`,
      `dust auth  : ${result.dust_auth}`,
    ]
    if (result.dust_auth === 'missing') {
      lines.push(`hint       : ${result.hint}`)
      return lines
    }
    lines.push(
      `workspace  : ${result.workspace} (${result.region})`,
      `user       : ${result.user.email ?? result.user.username ?? 'unknown'}`,
      `token TTL  : ${formatDuration(result.token_ttl_seconds)}`,
      `credentials: updated ${result.credentials_updated_at}`,
      `models     : ${result.proxy.models} mapped, ${result.proxy.sessions} active session(s)`,
    )
    return lines
  })
  if (result.dust_auth === 'missing') process.exitCode = 1
}

async function localStatus(config: Config, opts: CommandOptions): Promise<void> {
  const creds = await new CredentialStore(config.dustCredentialFile).load()
  const payload = {
    proxy: 'unreachable',
    admin_url: config.adminBaseUrl,
    dust_auth: creds ? 'ok' : 'missing',
    workspace: creds?.workspaceSid ?? null,
    token_ttl_seconds: creds ? secondsUntilExpiry(creds.accessToken) : null,
  }
  print(opts.json ?? false, payload, () => [
    `proxy      : not reachable at ${config.adminBaseUrl}`,
    `dust auth  : ${payload.dust_auth}${creds ? ` (workspace ${creds.workspaceSid}, file only)` : ''}`,
    `hint       : ${UNREACHABLE_HINT}`,
  ])
}

// --- credits ----------------------------------------------------------------

export async function credits(config: Config, opts: CommandOptions = {}): Promise<void> {
  let result: any
  try {
    result = await call(config, '/internal/credits')
  } catch (err) {
    if (err instanceof ServerUnreachable) {
      throw new CommandError(`${err.message}\n${UNREACHABLE_HINT}`)
    }
    throw err
  }

  print(opts.json ?? false, result, () => {
    const lines = [`workspace  : ${result.workspace}`]
    if (result.plan) lines.push(`plan       : ${result.plan}`)
    lines.push(
      `allowance  : ${formatCredits(result.allowance)}`,
      `used       : ${formatCredits(result.used)}`,
      `remaining  : ${formatCredits(result.remaining)}`,
    )
    if (result.period_start) {
      lines.push(
        `period     : ${result.period_start.slice(0, 10)} → ${String(result.period_end).slice(0, 10)}`,
      )
    }
    lines.push(`source     : ${result.source}`)
    if (result.remaining === null) {
      lines.push(
        '',
        'Dust does not expose a credit balance on the public API. Set DUST_CREDIT_ALLOWANCE',
        'to your monthly allocation to have "remaining" computed from consumption.',
      )
    }
    return lines
  })
}

function formatCredits(value: number | null): string {
  if (value === null || value === undefined) return 'unknown'
  return Math.round(value * 100) / 100 === value
    ? value.toLocaleString('en-US')
    : value.toFixed(2)
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired'
  if (seconds < 120) return `${seconds}s`
  if (seconds < 7200) return `${Math.round(seconds / 60)}min`
  return `${Math.round(seconds / 3600)}h`
}
