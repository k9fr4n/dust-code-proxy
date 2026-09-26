import { describe, it, expect } from 'vitest'
import { ProxyError } from '../errors.js'
import {
  IDLE_STREAM_ERROR_MARKER,
  isIdleStreamTimeout,
  isTransientStreamError,
} from './stream-errors.js'

const idleError = new ProxyError(
  'api_error',
  `${IDLE_STREAM_ERROR_MARKER} for 120000ms; stream aborted.`,
  504,
)

describe('isIdleStreamTimeout', () => {
  it('recognises the idle-timeout ProxyError', () => {
    expect(isIdleStreamTimeout(idleError)).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isIdleStreamTimeout(new Error('terminated'))).toBe(false)
    expect(isIdleStreamTimeout(new ProxyError('api_error', 'boom', 502))).toBe(false)
  })
})

describe('isTransientStreamError', () => {
  it('treats upstream connection drops as transient', () => {
    for (const msg of [
      'terminated: other side closed',
      'fetch failed',
      'socket closed',
      'read ECONNRESET',
      'connect ETIMEDOUT',
    ]) {
      expect(isTransientStreamError(new Error(msg)), msg).toBe(true)
    }
  })

  it('never treats the idle timeout as transient (issue #35)', () => {
    // Resuming a stalled generation from the same cursor only re-arms the timeout.
    expect(isTransientStreamError(idleError)).toBe(false)
  })

  it('never treats a caller-driven abort as transient', () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    expect(isTransientStreamError(abort)).toBe(false)
  })

  it('does not resume API-level errors', () => {
    expect(
      isTransientStreamError(new ProxyError('api_error', 'Dust SSE stream failed (500)', 502)),
    ).toBe(false)
    expect(isTransientStreamError(new Error('unexpected token'))).toBe(false)
  })
})
