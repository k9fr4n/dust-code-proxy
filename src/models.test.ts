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

describe('ModelRouter configurationId resolution (sId / name / modelId)', () => {
  const routed: DustAgentConfig[] = [
    {
      sId: 'sSonnet',
      name: 'Claude_Sonnet_5',
      modelId: 'claude-sonnet-5',
      scope: 'hidden',
      status: 'active',
      userFavorite: false,
    },
    {
      sId: 'sHaiku',
      name: 'Claude_4.5_Haiku',
      modelId: 'claude-haiku-4-5-20251001',
      scope: 'hidden',
      status: 'active',
      userFavorite: true,
    },
  ]

  it('passes a mapped sId through unchanged', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'sSonnet' } })
    router.setAgents(routed)
    expect(router.resolve('sonnet')).toBe('sSonnet')
  })

  it('resolves a mapped agent name to its sId', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'Claude_Sonnet_5' } })
    router.setAgents(routed)
    expect(router.resolve('sonnet')).toBe('sSonnet')
  })

  it('resolves a mapped modelId to the agent running it', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    router.setAgents(routed)
    expect(router.resolve('sonnet')).toBe('sSonnet')
  })

  it('passes a modelId through when the agent list is not loaded', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    expect(router.resolve('sonnet')).toBe('claude-sonnet-5')
  })

  it('throws when a mapped id matches no agent, name or modelId', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-opus-5' } })
    router.setAgents(routed)
    expect(() => router.resolve('sonnet')).toThrow(/does not exist in the workspace/)
  })
})

describe('ModelRouter modelId disambiguation', () => {
  const shared: DustAgentConfig[] = [
    {
      sId: 'visible',
      name: 'Sonnet_Published',
      modelId: 'claude-sonnet-5',
      scope: 'visible',
      status: 'active',
      userFavorite: false,
    },
    {
      sId: 'archived',
      name: 'Sonnet_Old',
      modelId: 'claude-sonnet-5',
      scope: 'hidden',
      status: 'archived',
      userFavorite: true,
    },
    {
      sId: 'personal',
      name: 'Claude_Sonnet_5',
      modelId: 'claude-sonnet-5',
      scope: 'hidden',
      status: 'active',
      userFavorite: false,
    },
  ]

  it('prefers active over archived', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    router.setAgents(shared)
    expect(router.resolve('sonnet')).toBe('personal')
  })

  it('prefers hidden over visible when both are active', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    router.setAgents([shared[0], shared[2]])
    expect(router.resolve('sonnet')).toBe('personal')
  })

  it('breaks ties by smallest sId', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    const a = { ...shared[2], sId: 'b', userFavorite: false }
    const b = { ...shared[2], sId: 'a', userFavorite: false }
    router.setAgents([a, b])
    expect(router.resolve('sonnet')).toBe('a')
  })
})

describe('ModelRouter modelId fallback in resolve', () => {
  const routed: DustAgentConfig[] = [
    {
      sId: 'sOpus',
      name: 'Claude_Opus_5_5',
      modelId: 'claude-opus-5-5',
      scope: 'hidden',
      status: 'active',
      userFavorite: false,
    },
  ]

  it('routes a catalog modelId with no models.json entry', () => {
    const router = new ModelRouter({})
    router.setAgents(routed)
    expect(router.resolve('claude-opus-5-5')).toBe('sOpus')
  })

  it('still prefers a models.json mapping over the modelId fallback', () => {
    const router = new ModelRouter({ 'claude-opus-5-5': { configurationId: 'sOpus' } })
    router.setAgents(routed)
    expect(router.resolve('claude-opus-5-5')).toBe('sOpus')
  })

  it('still throws when no mapping, name or modelId matches', () => {
    const router = new ModelRouter({})
    router.setAgents(routed)
    expect(() => router.resolve('claude-opus-4-8')).toThrow(/No Dust agent configured/)
  })
})

describe('ModelRouter routableModels', () => {
  const routed: DustAgentConfig[] = [
    { sId: 'sSonnet', name: 'Claude_Sonnet_5', modelId: 'claude-sonnet-5' },
    { sId: 'sHaiku', name: 'Claude_4.5_Haiku', modelId: 'claude-haiku-4-5-20251001' },
  ]

  it('returns the deduped union of mapping keys, sIds, names and modelIds', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'sSonnet' } })
    router.setAgents(routed)
    const ids = router.routableModels().map((r) => r.id).sort()
    expect(ids).toEqual([
      'Claude_4.5_Haiku',
      'Claude_Sonnet_5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'sHaiku',
      'sSonnet',
      'sonnet',
    ])
  })

  it('carries the agent name as displayName for sIds and names, none for modelIds', () => {
    const router = new ModelRouter({})
    router.setAgents(routed)
    const byId = new Map(router.routableModels().map((r) => [r.id, r.displayName]))
    expect(byId.get('sSonnet')).toBe('Claude_Sonnet_5')
    expect(byId.get('Claude_Sonnet_5')).toBe('Claude_Sonnet_5')
    expect(byId.get('claude-sonnet-5')).toBeUndefined()
  })
})

describe('ModelRouter modelsForAgent and missingMappedIds', () => {
  const routed: DustAgentConfig[] = [
    { sId: 'sSonnet', name: 'Claude_Sonnet_5', modelId: 'claude-sonnet-5' },
    { sId: 'sHaiku', name: 'Claude_4.5_Haiku', modelId: 'claude-haiku-4-5-20251001' },
  ]

  it('reports a modelId mapping under the agent it resolves to', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    router.setAgents(routed)
    expect(router.modelsForAgent('sSonnet')).toEqual(['sonnet'])
    expect(router.modelsForAgent('sHaiku')).toEqual([])
  })

  it('does not flag a mapped modelId as missing', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-sonnet-5' } })
    router.setAgents(routed)
    expect(router.missingMappedIds()).toEqual([])
  })

  it('flags an id that matches nothing', () => {
    const router = new ModelRouter({ sonnet: { configurationId: 'claude-opus-5' } })
    router.setAgents(routed)
    expect(router.missingMappedIds()).toEqual(['sonnet -> claude-opus-5'])
  })
})
