import { DustStreamEvent } from '../dust/sse.js'

// Translation of Dust message-stream events into Anthropic SSE events consumed by
// Claude Code. The MVP is text-only: tool_* events are deliberately ignored (the
// MCP tool bridge is phase 2 / step 5). `generation_tokens.classification` is used
// to separate the reasoning trace (`chain_of_thought` + delimiter markers) from the
// assistant's answer (`tokens`); only the answer is emitted. Mapping the trace to
// Anthropic `thinking` blocks remains a TODO.

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: Record<string, unknown> }
  | { type: 'content_block_start'; index: number; content_block: Record<string, unknown> }
  | { type: 'content_block_delta'; index: number; delta: Record<string, unknown> }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: Record<string, unknown>; usage?: Record<string, unknown> }
  | { type: 'message_stop' }
  | { type: 'error'; error: Record<string, unknown> }

const TERMINAL_EVENT_TYPES = new Set([
  'agent_message_success',
  'agent_message_gracefully_stopped',
  'agent_generation_cancelled',
  'agent_error',
  'user_message_error',
])

export function isTerminalDustEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type)
}

// Dust models a message body as either a plain string or a nested tree of content
// nodes (`{ text }`, `{ content }`, `{ contents: [...] }`, `{ title, content }`,
// …). Flatten any of those shapes to the visible text, ignoring metadata such as a
// node's `title` (which is not part of the assistant's answer).
function extractTextContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map(extractTextContent)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
    return parts.length ? parts.join('\n\n') : undefined
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (typeof o.content === 'string') return o.content
    const nested = extractTextContent(o.content) ?? extractTextContent(o.contents)
    if (nested !== undefined) return nested
  }
  return undefined
}

// Shown when a Dust turn completes without any visible answer (see
// `StreamTranslator.ensureVisibleText`).
export const NO_VISIBLE_ANSWER_TEXT =
  '(The Dust agent completed this turn without producing a visible answer.)'

export class StreamTranslator {
  text = ''
  stopReason: string | null = null
  errored = false
  errorMessage = ''

  private messageStarted = false
  private blockOpen = false
  private finished = false
  private textBlockEmitted = false
  private toolUseCount = 0

  // Tool-use blocks emitted this turn, retained so a non-streaming collector can
  // render them as `tool_use` content blocks instead of SSE input_json_delta frames.
  toolUses: { id: string; name: string; input: unknown }[] = []

  constructor(
    private readonly messageId: string,
    private readonly model: string,
  ) {}

  translate(event: DustStreamEvent): AnthropicStreamEvent[] {
    switch (event.type) {
      case 'generation_tokens': {
        // Dust tags each token with a `classification`. Only `tokens` is the
        // assistant's actual answer; `chain_of_thought` (and the `opening_delimiter`
        // / `closing_delimiter` markers) is the reasoning trace and must not leak
        // into the visible text — otherwise it reads as a garbled preamble and, on
        // the success-event reconciliation below, blocks the real answer.
        if (event.classification !== undefined && event.classification !== 'tokens') {
          return []
        }
        const text = typeof event.text === 'string' ? event.text : ''
        return this.onText(text)
      }
      case 'agent_message_success':
      case 'agent_message_gracefully_stopped': {
        const out: AnthropicStreamEvent[] = []
        // The success event carries the authoritative full answer (`message.content`).
        // If the answer was not streamed (or only partially), emit the missing part
        // now so the client always receives the complete response.
        const full = this.extractFullText(event)
        if (full) {
          if (!this.text) {
            out.push(...this.onText(full))
          } else if (full.startsWith(this.text) && full.length > this.text.length) {
            out.push(...this.onText(full.slice(this.text.length)))
          }
        }
        out.push(...this.ensureVisibleText())
        out.push(...this.finish('end_turn'))
        return out
      }
      case 'agent_generation_cancelled': {
        const out = this.ensureVisibleText()
        out.push(...this.finish('end_turn'))
        return out
      }
      case 'agent_error':
      case 'user_message_error':
        return this.onError(event)
      default:
        return []
    }
  }

  isFinished(): boolean {
    return this.finished
  }

  // Claude Code requires every assistant turn to carry visible content: a turn with
  // none makes it inject "[Your previous response had no visible output. Please
  // continue and produce a user-visible response.]" and retry. A Dust agent that
  // ends its turn right after its tool calls stores an empty `content`, so emit an
  // explicit note instead of nothing. Must be called *before* `finish()`: once the
  // turn is closed no content block can be added.
  ensureVisibleText(text = NO_VISIBLE_ANSWER_TEXT): AnthropicStreamEvent[] {
    if (this.finished || this.text || this.toolUses.length > 0) return []
    return this.onText(text)
  }

  finishExternally(stopReason = 'end_turn'): AnthropicStreamEvent[] {
    return this.finish(stopReason)
  }

  error(message: string): AnthropicStreamEvent[] {
    this.errored = true
    this.errorMessage = message
    this.finished = true
    return [{ type: 'error', error: { type: 'api_error', message } }]
  }

  // Emits a single `tool_use` content block. Dust may dispatch several parallel
  // tool calls back-to-back, so this does NOT end the turn: the caller emits one
  // block per `tools/call` and then calls `finishToolUse` once they have all
  // arrived. Ending the turn here (as before) would drop every tool_use after the
  // first, leaving Claude Code with a subset of the requested tools and the agent
  // parked forever waiting for the missing results.
  emitToolUseBlock(toolUseId: string, name: string, input: unknown): AnthropicStreamEvent[] {
    // A turn already ended (end_turn/error) cannot also emit a tool_use.
    if (this.finished) return []
    this.toolUses.push({ id: toolUseId, name, input })
    const out: AnthropicStreamEvent[] = []
    if (!this.messageStarted) {
      out.push(this.messageStart())
      this.messageStarted = true
    }
    if (this.blockOpen) {
      out.push({ type: 'content_block_stop', index: 0 })
      this.blockOpen = false
    }
    const index = (this.textBlockEmitted ? 1 : 0) + this.toolUseCount
    this.toolUseCount += 1
    // Anthropic streams a tool_use block's input through `input_json_delta`
    // partial-JSON events, not through `content_block_start.input` (which is always
    // `{}`). Claude Code rebuilds the input from those deltas (`__json_buf` +
    // JSON.parse); emitting the input only in `content_block_start` leaves the buffer
    // empty and its local validation rejects `command` as "unknown".
    out.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
    })
    out.push({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) },
    })
    out.push({ type: 'content_block_stop', index })
    return out
  }

  // Ends the turn with `stop_reason: tool_use` after every `tool_use` block has
  // been emitted (see `emitToolUseBlock`).
  finishToolUse(): AnthropicStreamEvent[] {
    if (this.finished) return []
    this.stopReason = 'tool_use'
    this.finished = true
    return [
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 0 },
      },
      { type: 'message_stop' },
    ]
  }

  private onText(text: string): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    if (!this.messageStarted) {
      out.push(this.messageStart())
      this.messageStarted = true
    }
    if (!this.blockOpen) {
      out.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      this.blockOpen = true
      this.textBlockEmitted = true
    }
    if (text) {
      this.text += text
      out.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })
    }
    return out
  }

  private finish(stopReason: string): AnthropicStreamEvent[] {
    const out: AnthropicStreamEvent[] = []
    if (!this.messageStarted) {
      out.push(this.messageStart())
      this.messageStarted = true
    }
    if (this.blockOpen) {
      out.push({ type: 'content_block_stop', index: 0 })
      this.blockOpen = false
    }
    if (!this.finished) {
      this.stopReason = stopReason
      out.push({
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 0 },
      })
      out.push({ type: 'message_stop' })
      this.finished = true
    }
    return out
  }

  private onError(event: DustStreamEvent): AnthropicStreamEvent[] {
    const message =
      typeof event.message === 'string'
        ? event.message
        : typeof event.code === 'string'
          ? event.code
          : 'Dust agent error'
    return this.error(message)
  }

  private messageStart(): AnthropicStreamEvent {
    return {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  private extractFullText(event: DustStreamEvent): string | undefined {
    const message = event.message as Record<string, unknown> | undefined
    if (message) {
      const fromContent = extractTextContent(message.content)
      if (fromContent !== undefined) return fromContent
      const fromContents = extractTextContent(message.contents)
      if (fromContents !== undefined) return fromContents
    }
    const contentView = event.contentView as Record<string, unknown> | undefined
    if (contentView) {
      const fromView = extractTextContent(contentView.content)
      if (fromView !== undefined) return fromView
    }
    return extractTextContent(event.content)
  }
}

export function serializeSse(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
