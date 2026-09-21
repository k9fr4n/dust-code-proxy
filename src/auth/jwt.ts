// Minimal JWT decode: we only read the payload to get the expiry (`exp`) and the
// Dust region claim (`https://dust.tt/region`). No signature verification — the
// token is obtained over TLS from WorkOS and verified by Dust on each call.
export type DustRegion = 'us-central1' | 'europe-west1'

export interface DecodedJwt {
  exp?: number
  region?: DustRegion
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const obj = JSON.parse(json) as Record<string, unknown>
    const regionClaim = obj['https://dust.tt/region']
    return {
      exp: typeof obj.exp === 'number' ? obj.exp : undefined,
      region:
        regionClaim === 'europe-west1'
          ? 'europe-west1'
          : regionClaim === 'us-central1'
            ? 'us-central1'
            : undefined,
    }
  } catch {
    return {}
  }
}

export function secondsUntilExpiry(token: string): number {
  const { exp } = decodeJwt(token)
  if (!exp) return 0
  return exp - Math.floor(Date.now() / 1000)
}
