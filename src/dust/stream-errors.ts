import { ProxyError } from '../errors.js'

// Classification of SSE stream failures, shared by the message-events stream
// (`DustClient.stream`) and the MCP requests stream (`DustMcpTransport`). Kept in
// its own module so `dust/mcp.ts` can use it without importing `dust/client.ts`
// (which imports `dust/mcp.ts` for its response schemas).

// Message of the `ProxyError` raised by `DustClient.stream` when `idleStreamMs`
// elapses between two events.
export const IDLE_STREAM_ERROR_MARKER = 'No Dust event received'

// Our own idle timeout: no event arrived for `idleStreamMs`. This is NOT a dropped
// connection — the socket is healthy, the generation went silent — so re-opening
// the stream from the same cursor just re-arms the same timeout (see issue #35).
export function isIdleStreamTimeout(err: unknown): boolean {
  return err instanceof ProxyError && err.message.includes(IDLE_STREAM_ERROR_MARKER)
}

// Network-level stream failures that are safe to recover from by re-opening the SSE
// stream from the last event id: the upstream (or a CDN in front of it) dropped the
// connection. Caller-driven aborts (AbortError) are cancellation, never a drop, and
// the idle timeout is a stalled generation, not a drop: both are excluded.
export function isTransientStreamError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  if (name === 'AbortError') return false
  if (isIdleStreamTimeout(err)) return false
  if (err instanceof ProxyError) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /terminated|other side closed|fetch failed|network error|socket closed|connection reset|ETIMEDOUT|ECONNRESET|ECONNREFUSED/.test(
    msg,
  )
}
