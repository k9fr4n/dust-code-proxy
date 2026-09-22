// SSE parsing for Dust streams.
//
// Dust wraps every event as:
//   event: message
//   data: {"eventId":"123","data":{"type":"generation_tokens","text":"...","...":...}}
// and terminates the stream with a literal `data: done` (not JSON).

export interface DustStreamEvent {
  type: string
  eventId?: string
  [key: string]: unknown
}

export type ParsedDustEvent =
  | { kind: 'event'; eventId: string; type: string; data: DustStreamEvent }
  | { kind: 'done' }
  | { kind: 'unknown'; raw: string }

export function parseDustData(data: string): ParsedDustEvent | null {
  const trimmed = data.trim()
  if (trimmed === '') return null
  if (trimmed === 'done') return { kind: 'done' }
  try {
    const obj = JSON.parse(trimmed) as { eventId?: unknown; data?: unknown }
    const eventId = typeof obj.eventId === 'string' ? obj.eventId : ''
    const inner = obj.data
    if (
      inner &&
      typeof inner === 'object' &&
      typeof (inner as Record<string, unknown>).type === 'string'
    ) {
      return {
        kind: 'event',
        eventId,
        type: (inner as Record<string, unknown>).type as string,
        data: inner as DustStreamEvent,
      }
    }
    return { kind: 'unknown', raw: trimmed }
  } catch {
    return { kind: 'unknown', raw: trimmed }
  }
}

function collectDataLines(block: string): string[] {
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const field = line.slice(0, colon)
    let value = line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    // `event`, `id`, `retry` fields are ignored: the type is carried in the JSON.
  }
  return dataLines
}

export function parseSseBlock(block: string): ParsedDustEvent | null {
  const dataLines = collectDataLines(block)
  if (dataLines.length === 0) return null
  return parseDustData(dataLines.join('\n'))
}

// The MCP requests stream (`GET mcp/requests`) uses the same envelope shape but
// carries a raw JSON-RPC message in `data` (no `type` field), so it needs its own
// parser distinct from `parseDustData`.
export type ParsedMcpRequest =
  | { kind: 'event'; eventId: string; data: Record<string, unknown> }
  | { kind: 'done' }
  | { kind: 'unknown'; raw: string }

export function parseMcpRequestData(data: string): ParsedMcpRequest | null {
  const trimmed = data.trim()
  if (trimmed === '') return null
  if (trimmed === 'done') return { kind: 'done' }
  try {
    const obj = JSON.parse(trimmed) as { eventId?: unknown; data?: unknown }
    const eventId = typeof obj.eventId === 'string' ? obj.eventId : ''
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      return { kind: 'event', eventId, data: obj.data as Record<string, unknown> }
    }
    return { kind: 'unknown', raw: trimmed }
  } catch {
    return { kind: 'unknown', raw: trimmed }
  }
}

export function parseMcpSseBlock(block: string): ParsedMcpRequest | null {
  const dataLines = collectDataLines(block)
  if (dataLines.length === 0) return null
  return parseMcpRequestData(dataLines.join('\n'))
}

async function* streamSseRaw<T>(
  body: ReadableStream<Uint8Array>,
  opts: { signal?: AbortSignal } | undefined,
  parseBlock: (block: string) => T | null,
): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const event = parseBlock(block)
        if (event) yield event
      }
    }
    const remaining = buffer.replace(/\r/g, '')
    if (remaining.trim() !== '') {
      const event = parseBlock(remaining)
      if (event) yield event
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export async function* streamSse(
  body: ReadableStream<Uint8Array>,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<ParsedDustEvent> {
  yield* streamSseRaw(body, opts, parseSseBlock)
}

export async function* streamMcpRequests(
  body: ReadableStream<Uint8Array>,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<ParsedMcpRequest> {
  yield* streamSseRaw(body, opts, parseMcpSseBlock)
}
