import { describe, it, expect } from 'vitest'
import { findAgentMessageState } from './parse.js'

// Shape observed on the real API (GET /api/v1/w/:ws/assistant/conversations/:id):
// `content` is an array of message groups. The production case that motivated this
// helper had `status: 'succeeded'` with an empty `content` and 4 tool actions.
const conversationPayload = {
  conversation: {
    sId: '7FtDDGH54R',
    content: [
      [{ sId: 'umsg_1', type: 'user_message', content: 'go' }],
      [
        {
          sId: 'CG5xcnF5Ce',
          type: 'agent_message',
          status: 'succeeded',
          content: '',
          chainOfThought: 'Let me check the repository.',
          actions: [{ type: 'tool_action' }],
        },
      ],
      [{ sId: 'umsg_2', type: 'user_message', content: 'continue' }],
      [{ sId: 'TZqFOI4HXc', type: 'agent_message', status: 'succeeded', content: 'Done.' }],
    ],
  },
}

describe('findAgentMessageState', () => {
  it('reads the status, content and reasoning of the requested message', () => {
    expect(findAgentMessageState(conversationPayload, 'CG5xcnF5Ce')).toEqual({
      sId: 'CG5xcnF5Ce',
      status: 'succeeded',
      content: '',
      chainOfThought: 'Let me check the repository.',
      error: undefined,
    })
  })

  it('does not confuse two agent messages of the same conversation', () => {
    expect(findAgentMessageState(conversationPayload, 'TZqFOI4HXc')?.content).toBe('Done.')
  })

  it('ignores user messages and unknown ids', () => {
    expect(findAgentMessageState(conversationPayload, 'umsg_1')).toBeUndefined()
    expect(findAgentMessageState(conversationPayload, 'nope')).toBeUndefined()
  })

  it('normalises an error object into a message', () => {
    const payload = {
      content: [
        [
          {
            sId: 'a1',
            type: 'agent_message',
            status: 'failed',
            error: { code: 'x', message: 'model overloaded' },
          },
        ],
      ],
    }
    expect(findAgentMessageState(payload, 'a1')).toMatchObject({
      status: 'failed',
      error: 'model overloaded',
    })
  })

  it('survives a payload with cycles and unexpected shapes', () => {
    const cyclic: Record<string, unknown> = { content: [] }
    cyclic.self = cyclic
    expect(findAgentMessageState(cyclic, 'a1')).toBeUndefined()
    expect(findAgentMessageState(null, 'a1')).toBeUndefined()
    expect(findAgentMessageState('nonsense', 'a1')).toBeUndefined()
  })
})
