// OAuth 2.0 device-code flow against WorkOS, mirroring the official Dust CLI.
//   POST https://api.workos.com/user_management/authorize/device
//   POST https://api.workos.com/user_management/authenticate  (poll + refresh)

const WORKOS_API = 'https://api.workos.com'
const FETCH_TIMEOUT_MS = 15000

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export async function startDeviceAuthorization(
  clientId: string,
): Promise<DeviceAuthorization> {
  const json = await postForm(`${WORKOS_API}/user_management/authorize/device`, {
    client_id: clientId,
    scope: 'openid profile email',
  })
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: json.verification_uri_complete,
    expiresIn: json.expires_in ?? 600,
    interval: json.interval ?? 5,
  }
}

export type PollOutcome =
  | { status: 'authorized'; tokens: TokenPair }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

export async function pollDeviceGrant(
  clientId: string,
  deviceCode: string,
): Promise<PollOutcome> {
  let res: Response
  try {
    res = await fetchWithTimeout(`${WORKOS_API}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
      }).toString(),
    })
  } catch (err) {
    return { status: 'error', message: `Network error: ${(err as Error).message}` }
  }

  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = {}
  }

  if (res.ok && json.access_token && json.refresh_token) {
    return {
      status: 'authorized',
      tokens: {
        accessToken: String(json.access_token),
        refreshToken: String(json.refresh_token),
      },
    }
  }

  const error = json.error
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'slow_down' }
  if (error === 'access_denied') {
    return { status: 'error', message: 'Access denied by the user.' }
  }
  if (error === 'expired_token' || error === 'invalid_grant') {
    return { status: 'expired' }
  }
  return {
    status: 'error',
    message: `Unexpected WorkOS response: ${text.slice(0, 200)}`,
  }
}

export async function refreshTokens(
  clientId: string,
  refreshToken: string,
): Promise<TokenPair> {
  const json = await postForm(`${WORKOS_API}/user_management/authenticate`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  if (!json.access_token) {
    throw new Error(`Refresh failed: ${JSON.stringify(json)}`)
  }
  return {
    accessToken: json.access_token,
    // WorkOS may not rotate the refresh token; keep the old one in that case.
    refreshToken: json.refresh_token ?? refreshToken,
  }
}

async function postForm(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, any>> {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(text) as Record<string, any>
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    throw new Error(
      `WorkOS error ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
    )
  }
  return json
}
