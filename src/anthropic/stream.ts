import { DustStreamEvent } from '../dust/sse.js'

// Translation of Dust message-stream events into Anthropic SSE events consumed by
// Claude Code. The MVP is text-only: tool_* events are deliberately ignored (the
// MCP tool bridge is phase 2 / step 5). `generation_tokens.classification` is
// logged by the caller but currently mapped as plain text; mapping it to Anthropic
// `thinking` blocks is a TODO once the exact values are observed in production.

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

export class StreamTranslator {
  text = ''
  stopReason: string | null = null
  errored = false
  errorMessage = ''

  private messageStarted = false
  private blockOpen = false
  private finished = false
  private textBlockEmitted = false

  constructor(
    private readonly messageId: string,
    private readonly model: string,
  ) {}

  translate(event: DustStreamEvent): AnthropicStreamEvent[] {
    switch (event.type) {
      case 'generation_tokens': {
        const text = typeof event.text === 'string' ? event.text : ''
        return this.onText(text)
      }
      case 'agent_message_success':
      case 'agent_message_gracefully_stopped': {
        const full = this.extractFullText(event)
        if (full && !this.text) this.text = full
        return this.finish('end_turn')
      }
      case 'agent_generation_cancelled':
        return this.finish('end_turn')
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

  finishExternally(stopReason = 'end_turn'): AnthropicStreamEvent[] {
    return this.finish(stopReason)
  }

  error(message: string): AnthropicStreamEvent[] {
    this.errored = true
    this.errorMessage = message
    this.finished = true
    return [{ type: 'error', error: { type: 'api_error', message } }]
  }

  // Emits a `tool_use` content block and ends the turn with `stop_reason: tool_use`.
  // Called by the MCP bridge when a Dust `tools/call` is relayed to Claude Code.
  emitToolUse(toolUseId: string, name: string, input: unknown): AnthropicStreamEvent[] {
    // A turn already ended (end_turn/error) cannot also emit a tool_use.
    if (this.finished) return []
    const out: AnthropicStreamEvent[] = []
    if (!this.messageStarted) {
      out.push(this.messageStart())
      this.messageStarted = true
    }
    if (this.blockOpen) {
      out.push({ type: 'content_block_stop', index: 0 })
      this.blockOpen = false
    }
    const index = this.textBlockEmitted ? 1 : 0
    out.push({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: toolUseId, name, input },
    })
    out.push({ type: 'content_block_stop', index })
    if (!this.finished) {
      this.stopReason = 'tool_use'
      out.push({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 0 },
      })
      out.push({ type: 'message_stop' })
      this.finished = true
    }
    return out
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
    if (message && typeof message.content === 'string') return message.content
    if (typeof event.content === 'string') return event.content
    return undefined
  }
}

export function serializeSse(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
