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

export function parseSseBlock(block: string): ParsedDustEvent | null {
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
  if (dataLines.length === 0) return null
  return parseDustData(dataLines.join('\n'))
}

export async function* streamSse(
  body: ReadableStream<Uint8Array>,
  opts?: { signal?: AbortSignal },
): AsyncGenerator<ParsedDustEvent> {
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
        const event = parseSseBlock(block)
        if (event) yield event
      }
    }
    const remaining = buffer.replace(/\r/g, '')
    if (remaining.trim() !== '') {
      const event = parseSseBlock(remaining)
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
