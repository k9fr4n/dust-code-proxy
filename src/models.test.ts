import { describe, it, expect } from 'vitest'
import { ModelRouter } from './models.js'
import { DustAgentConfig } from './dust/parse.js'

const agents: DustAgentConfig[] = [
  { sId: 'dLy1V6JMMD', name: 'Claude_Sonnet_5' },
  { sId: 'helper', name: 'help' },
]

describe('ModelRouter default agent resolution', () => {
  it('resolves a default agent display name to its sId', () => {
    const router = new ModelRouter({}, 'Claude_Sonnet_5')
    router.setAgents(agents)
    expect(router.resolve('any-model')).toBe('dLy1V6JMMD')
  })

  it('passes a default agent sId through unchanged', () => {
    const router = new ModelRouter({}, 'dLy1V6JMMD')
    router.setAgents(agents)
    expect(router.resolve('any-model')).toBe('dLy1V6JMMD')
  })

  it('falls back to the raw default id when the agent list is not loaded', () => {
    const router = new ModelRouter({}, 'Claude_Sonnet_5')
    expect(router.resolve('any-model')).toBe('Claude_Sonnet_5')
  })

  it('throws when no default agent and no mapping match', () => {
    const router = new ModelRouter({}, undefined)
    expect(() => router.resolve('unknown')).toThrow(/No Dust agent configured/)
  })
})
