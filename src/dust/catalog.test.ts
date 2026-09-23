import { describe, expect, it } from 'vitest'
import { parseModelCatalog } from './catalog.js'
import { ProxyError } from '../errors.js'

// Payload captured from GET /api/w/{wId}/models on eu.dust.tt (trimmed).
const payload = {
  models: [
    {
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      contextSize: 250000,
      generationTokensCount: 64000,
      largeModel: true,
      isLegacy: false,
      isLatest: false,
      isSelectable: true,
      supportsVision: true,
      shortDescription: "Anthropic's flagship model.",
      supportedReasoningEfforts: { none: false, light: true, medium: true, high: true },
      defaultReasoningEffort: 'medium',
    },
    {
      providerId: 'mistral',
      modelId: 'codestral-latest',
      displayName: 'Mistral Codestral',
      contextSize: 128000,
      generationTokensCount: 2048,
      isSelectable: false,
      supportsVision: false,
    },
  ],
  defaultModel: {
    providerId: 'auto',
    modelId: 'auto',
    displayName: 'Standard',
    contextSize: 1000000,
  },
  streams: {
    auto: {
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      displayName: 'GPT 5.6 Luna',
      reasoningEffort: 'high',
    },
  },
  degradedModelIds: ['codestral-latest'],
}

describe('parseModelCatalog', () => {
  it('normalises the catalog', () => {
    const catalog = parseModelCatalog(payload, 'test')
    expect(catalog.models).toHaveLength(2)
    expect(catalog.models[0]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      contextSize: 250000,
      maxOutputTokens: 64000,
      supportsVision: true,
      degraded: false,
      description: "Anthropic's flagship model.",
    })
    // Only the supported efforts are kept, in payload order.
    expect(catalog.models[0].reasoningEfforts).toEqual(['light', 'medium', 'high'])
    expect(catalog.defaultModel?.modelId).toBe('auto')
  })

  it('flags degraded models and keeps the non-selectable ones', () => {
    const catalog = parseModelCatalog(payload, 'test')
    expect(catalog.models[1]).toMatchObject({
      modelId: 'codestral-latest',
      isSelectable: false,
      degraded: true,
    })
    expect(catalog.models[1].reasoningEfforts).toEqual([])
  })

  it('exposes the routing tiers as a list', () => {
    const catalog = parseModelCatalog(payload, 'test')
    expect(catalog.streams).toEqual([
      {
        stream: 'auto',
        providerId: 'openai',
        modelId: 'gpt-5.6-luna',
        displayName: 'GPT 5.6 Luna',
        reasoningEffort: 'high',
      },
    ])
  })

  it('tolerates a payload reduced to the identity fields', () => {
    const catalog = parseModelCatalog(
      { models: [{ providerId: 'openai', modelId: 'gpt-6-sol' }] },
      'test',
    )
    expect(catalog.models[0].displayName).toBeUndefined()
    expect(catalog.defaultModel).toBeUndefined()
    expect(catalog.streams).toEqual([])
  })

  it('rejects a payload without the model list', () => {
    expect(() => parseModelCatalog({ foo: 1 }, 'test')).toThrow(ProxyError)
  })
})
