// Errors mapped to the envelope expected by the Anthropic SDK used by Claude Code:
// { "type": "error", "error": { "type": "...", "message": "..." } }

export class ProxyError extends Error {
  constructor(
    public readonly type: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

export class DustAuthError extends ProxyError {
  constructor(message: string) {
    super('authentication_error', message, 401)
    this.name = 'DustAuthError'
  }
}

export function anthropicErrorBody(
  type: string,
  message: string,
): Record<string, unknown> {
  return { type: 'error', error: { type, message } }
}
