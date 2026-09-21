import { createInterface } from 'node:readline'
import { Config } from './config.js'
import { startDeviceAuthorization, pollDeviceGrant } from './auth/oauth.js'
import { decodeJwt } from './auth/jwt.js'
import { CredentialStore, Credentials } from './auth/credentials.js'
import { parseMe } from './dust/parse.js'

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

async function fetchMe(base: string, token: string) {
  const res = await fetch(`${base}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /api/v1/me failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return parseMe(await res.json())
}

export async function login(
  config: Config,
  opts: { force?: boolean; workspace?: string },
): Promise<void> {
  const store = new CredentialStore(config.dustCredentialFile)
  const existing = await store.load()
  if (existing && !opts.force) {
    console.log(`Already logged in (workspace ${existing.workspaceSid}). Use --force to re-login.`)
    return
  }

  console.log('Starting Dust device login...')
  const auth = await startDeviceAuthorization(config.dustOAuthClientId)
  console.log('')
  console.log('To sign in, open this URL in your browser:')
  console.log(`  ${auth.verificationUriComplete}`)
  console.log('')
  console.log(`Then enter this code if prompted: ${auth.userCode}`)
  console.log('')
  console.log('Waiting for authorization...')

  const startedAt = Date.now()
  let interval = auth.interval
  let tokens: { accessToken: string; refreshToken: string } | undefined
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedAt > auth.expiresIn * 1000) {
      console.error('\nAuthorization expired. Please run the login command again.')
      process.exit(1)
    }
    await sleep(interval * 1000)
    const outcome = await pollDeviceGrant(config.dustOAuthClientId, auth.deviceCode)
    if (outcome.status === 'authorized') {
      tokens = outcome.tokens
      break
    }
    if (outcome.status === 'slow_down') {
      interval += 5
      continue
    }
    if (outcome.status === 'expired') {
      console.error('\nAuthorization expired.')
      process.exit(1)
    }
    if (outcome.status === 'error') {
      console.error(`\nLogin error: ${outcome.message}`)
      process.exit(1)
    }
    // pending -> keep polling
  }

  const { region } = decodeJwt(tokens.accessToken)
  const base = region === 'europe-west1' ? 'https://eu.dust.tt' : 'https://dust.tt'

  const me = await fetchMe(base, tokens.accessToken)

  let workspaceSid = opts.workspace
  if (!workspaceSid) {
    if (me.workspaces.length === 0) {
      console.error('No Dust workspaces available for this account.')
      process.exit(1)
    }
    if (me.workspaces.length === 1) {
      workspaceSid = me.workspaces[0].sId
    } else {
      console.log('\nSelect a workspace:')
      me.workspaces.forEach((w, i) => console.log(`  ${i + 1}. ${w.name} (${w.sId})`))
      const answer = await prompt('Enter number: ')
      const idx = Number.parseInt(answer, 10) - 1
      workspaceSid = me.workspaces[idx]?.sId
      if (!workspaceSid) {
        console.error('Invalid selection.')
        process.exit(1)
      }
    }
  }

  const creds: Credentials = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    workspaceSid,
    region: region ?? 'us-central1',
    username: me.username,
    fullName: me.fullName,
    email: me.email,
    updatedAt: new Date().toISOString(),
  }
  await store.save(creds)
  console.log(
    `\nLogged in as ${me.email ?? me.username ?? 'unknown'}, workspace "${workspaceSid}" selected.`,
  )
}

export async function logout(config: Config): Promise<void> {
  const store = new CredentialStore(config.dustCredentialFile)
  await store.clear()
  console.log('Logged out.')
}
