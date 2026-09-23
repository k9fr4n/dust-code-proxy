import { describe, it, expect } from 'vitest'
import { DustStreamEvent } from '../dust/sse.js'
import { StreamTranslator, isTerminalDustEvent } from './stream.js'

function event(type: string, extra: Record<string, unknown> = {}): DustStreamEvent {
  return { type, ...extra }
}

describe('StreamTranslator', () => {
  it('emits a full text sequence', () => {
    const translator = new StreamTranslator('msg_1', 'dust-coding-agent')
    const events = [
      ...translator.translate(event('generation_tokens', { text: 'Hel' })),
      ...translator.translate(event('generation_tokens', { text: 'lo' })),
      ...translator.translate(event('agent_message_success')),
    ]
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(translator.text).toBe('Hello')
    expect(translator.stopReason).toBe('end_turn')
  })

  it('emits a message even when no tokens arrive (empty response)', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    const events = translator.translate(event('agent_message_success'))
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'message_delta',
      'message_stop',
    ])
  })

  it('skips chain_of_thought and only emits tokens as text', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    const events = [
      ...translator.translate(
        event('generation_tokens', { text: 'reasoning…', classification: 'chain_of_thought' }),
      ),
      ...translator.translate(
        event('generation_tokens', { text: 'hello', classification: 'tokens' }),
      ),
      ...translator.translate(
        event('agent_message_success', { message: { content: 'hello' } }),
      ),
    ]
    expect(translator.text).toBe('hello')
    const deltas = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e as { delta: { text?: string } }).delta.text)
    expect(deltas).toEqual(['hello'])
  })

  it('surfaces the full answer from agent_message_success when no tokens streamed', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    // chain_of_thought streams, but the answer is only delivered on the terminal event.
    translator.translate(
      event('generation_tokens', { text: 'thinking', classification: 'chain_of_thought' }),
    )
    const events = translator.translate(
      event('agent_message_success', { message: { content: 'the real answer' } }),
    )
    expect(translator.text).toBe('the real answer')
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
  })

  it('emits only the missing tail when streamed tokens are a prefix', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    translator.translate(event('generation_tokens', { text: 'hel', classification: 'tokens' }))
    const events = translator.translate(
      event('agent_message_success', { message: { content: 'hello world' } }),
    )
    expect(translator.text).toBe('hello world')
    const deltas = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e as { delta: { text?: string } }).delta.text)
    expect(deltas).toEqual(['lo world'])
  })

  it('extracts text from structured message.contents', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    const events = translator.translate(
      event('agent_message_success', {
        message: { contents: [{ title: 'Test', content: 'body text' }] },
      }),
    )
    expect(translator.text).toBe('body text')
    expect(events.some((e) => e.type === 'content_block_delta')).toBe(true)
  })

  it('maps agent_error to an error event', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    const events = translator.translate(event('agent_error', { message: 'boom' }))
    expect(events[0].type).toBe('error')
    expect(translator.errored).toBe(true)
    expect(translator.errorMessage).toBe('boom')
  })

  it('is idempotent on repeated finish', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    translator.translate(event('generation_tokens', { text: 'x' }))
    translator.translate(event('agent_message_success'))
    expect(translator.finishExternally()).toEqual([])
  })

  it('emitToolUse emits a tool_use block and ends the turn', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    translator.translate(event('generation_tokens', { text: 'thinking' }))
    const events = translator.emitToolUse('toolu_1', 'bash', { command: 'ls' })
    expect(events.map((e) => e.type)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    const start = events[1] as { type: 'content_block_start'; content_block: Record<string, unknown> }
    expect(start.content_block).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'bash',
      input: { command: 'ls' },
    })
    expect(translator.stopReason).toBe('tool_use')
    expect(translator.isFinished()).toBe(true)
  })

  it('emitToolUse emits message_start when no text preceded it', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    const events = translator.emitToolUse('toolu_2', 'grep', {})
    expect(events[0].type).toBe('message_start')
    expect(events.map((e) => e.type)).toContain('content_block_start')
    expect(translator.isFinished()).toBe(true)
  })

  it('emitToolUse is idempotent after finish', () => {
    const translator = new StreamTranslator('msg_1', 'model')
    translator.translate(event('agent_message_success'))
    expect(translator.emitToolUse('toolu_3', 'x', {})).toEqual([])
  })
})

describe('isTerminalDustEvent', () => {
  it('recognizes terminal events', () => {
    expect(isTerminalDustEvent('agent_message_success')).toBe(true)
    expect(isTerminalDustEvent('agent_message_gracefully_stopped')).toBe(true)
    expect(isTerminalDustEvent('agent_error')).toBe(true)
    expect(isTerminalDustEvent('generation_tokens')).toBe(false)
    expect(isTerminalDustEvent('tool_call_started')).toBe(false)
  })
})
