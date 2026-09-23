import { randomUUID } from 'node:crypto'
import { Credentials } from './credentials.js'
import { DustRegion, decodeJwt } from './jwt.js'
import { startDeviceAuthorization, pollDeviceGrant, TokenPair } from './oauth.js'
import { DustWorkspaceInfo, MeInfo, parseMe } from '../dust/parse.js'

// Server-side state machine for the device-code login, so the login runs *inside
// the running proxy*: the CLI only renders the URL and relays the user's
// workspace choice. The server holds the device code and, on success, installs
// the credentials in the live DustClient — no restart, no stale in-memory token.
//
// Flows live in memory and are dropped as soon as they complete or expire.

export interface StartedFlow {
  flow: string
  verificationUri: string
  verificationUriComplete: string
  userCode: string
  expiresIn: number
  interval: number
}

export type LoginStep =
  | { status: 'pending'; interval: number }
  | { status: 'expired' }
  | { status: 'error'; message: string }
  | { status: 'select_workspace'; workspaces: DustWorkspaceInfo[] }
  | { status: 'authorized'; credentials: Credentials }

interface PendingFlow {
  deviceCode: string
  interval: number
  expiresAt: number
  tokens?: TokenPair
  region?: DustRegion
  me?: MeInfo
}

export function baseUrlForRegion(region: DustRegion | undefined): string {
  return region === 'europe-west1' ? 'https://eu.dust.tt' : 'https://dust.tt'
}

export async function fetchMe(base: string, token: string): Promise<MeInfo> {
  const res = await fetch(`${base}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /api/v1/me failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return parseMe(await res.json())
}

export class LoginFlowStore {
  private flows = new Map<string, PendingFlow>()

  constructor(private readonly clientId: string) {}

  async start(): Promise<StartedFlow> {
    this.prune()
    const auth = await startDeviceAuthorization(this.clientId)
    const flow = randomUUID()
    this.flows.set(flow, {
      deviceCode: auth.deviceCode,
      interval: auth.interval,
      expiresAt: Date.now() + auth.expiresIn * 1000,
    })
    return {
      flow,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      userCode: auth.userCode,
      expiresIn: auth.expiresIn,
      interval: auth.interval,
    }
  }

  // One WorkOS poll per call: the CLI drives the cadence, honouring the
  // `interval` returned with each `pending` step (bumped on `slow_down`).
  async poll(flow: string): Promise<LoginStep> {
    const state = this.flows.get(flow)
    if (!state) return { status: 'error', message: 'Unknown or completed login flow.' }
    if (Date.now() > state.expiresAt) {
      this.flows.delete(flow)
      return { status: 'expired' }
    }

    if (!state.tokens) {
      const outcome = await pollDeviceGrant(this.clientId, state.deviceCode)
      if (outcome.status === 'pending') return { status: 'pending', interval: state.interval }
      if (outcome.status === 'slow_down') {
        state.interval += 5
        return { status: 'pending', interval: state.interval }
      }
      if (outcome.status === 'expired') {
        this.flows.delete(flow)
        return { status: 'expired' }
      }
      if (outcome.status === 'error') {
        this.flows.delete(flow)
        return { status: 'error', message: outcome.message }
      }
      state.tokens = outcome.tokens
      state.region = decodeJwt(outcome.tokens.accessToken).region
    }

    if (!state.me) {
      try {
        state.me = await fetchMe(
          baseUrlForRegion(state.region),
          state.tokens.accessToken,
        )
      } catch (err) {
        this.flows.delete(flow)
        return { status: 'error', message: (err as Error).message }
      }
    }

    const workspaces = state.me.workspaces
    if (workspaces.length === 0) {
      this.flows.delete(flow)
      return {
        status: 'error',
        message: 'No Dust workspaces available for this account.',
      }
    }
    if (workspaces.length === 1) {
      return this.finish(flow, state, workspaces[0].sId)
    }
    return { status: 'select_workspace', workspaces }
  }

  selectWorkspace(flow: string, workspaceSid: string): LoginStep {
    const state = this.flows.get(flow)
    if (!state?.tokens || !state.me) {
      return { status: 'error', message: 'Unknown or incomplete login flow.' }
    }
    if (!state.me.workspaces.some((w) => w.sId === workspaceSid)) {
      return {
        status: 'error',
        message: `Workspace "${workspaceSid}" is not available for this account.`,
      }
    }
    return this.finish(flow, state, workspaceSid)
  }

  private finish(flow: string, state: PendingFlow, workspaceSid: string): LoginStep {
    if (!state.tokens) {
      return { status: 'error', message: 'Login flow has no tokens.' }
    }
    this.flows.delete(flow)
    return {
      status: 'authorized',
      credentials: {
        accessToken: state.tokens.accessToken,
        refreshToken: state.tokens.refreshToken,
        workspaceSid,
        region: state.region ?? 'us-central1',
        username: state.me?.username,
        fullName: state.me?.fullName,
        email: state.me?.email,
        updatedAt: new Date().toISOString(),
      },
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [flow, state] of this.flows) {
      if (now > state.expiresAt) this.flows.delete(flow)
    }
  }
}
