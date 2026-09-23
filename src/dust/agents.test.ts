import { describe, expect, it } from 'vitest'
import { parseAgentList } from './agents.js'
import { ProxyError } from '../errors.js'

// Payload captured from GET /api/w/{wId}/assistant/agent_configurations?view=manage
// on eu.dust.tt (trimmed).
const payload = {
  agentConfigurations: [
    {
      id: -1,
      sId: 'helper',
      version: 0,
      versionCreatedAt: null,
      name: 'help',
      description: 'Help on how to use Dust',
      pictureUrl: 'https://dust.tt/static/systemavatar/helper_avatar_full.png',
      status: 'active',
      userFavorite: false,
      scope: 'global',
      model: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        temperature: 0.2,
        reasoningEffort: 'medium',
      },
      actions: [],
      maxStepsPerRun: 64,
      tags: [],
      canRead: true,
      canEdit: false,
    },
    {
      id: 274879313187,
      sId: 'ggKOhTwS8Y',
      version: 3,
      versionCreatedAt: '2026-08-17T14:07:29.223Z',
      name: 'Claude_4.5_Haiku',
      description: 'Claude_4.5_Haiku',
      status: 'active',
      userFavorite: true,
      scope: 'hidden',
      model: {
        providerId: 'anthropic',
        modelId: 'claude-haiku-4-5-20251001',
        temperature: 0.7,
        reasoningEffort: 'light',
      },
      actions: [{ type: 'mcp_server_configuration' }, { type: 'search' }],
      maxStepsPerRun: 64,
      tags: [{ sId: 't1', name: 'coding', kind: 'standard' }],
      canRead: true,
      canEdit: true,
    },
  ],
}

describe('parseAgentList', () => {
  it('flattens the model and keeps the manage-view metadata', () => {
    const list = parseAgentList(payload, 'GET /agents')
    expect(list.source).toBe('GET /agents')
    expect(list.agents).toHaveLength(2)
    expect(list.agents[1]).toEqual({
      sId: 'ggKOhTwS8Y',
      name: 'Claude_4.5_Haiku',
      description: 'Claude_4.5_Haiku',
      scope: 'hidden',
      status: 'active',
      userFavorite: true,
      canEdit: true,
      version: 3,
      versionCreatedAt: '2026-08-17T14:07:29.223Z',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
      reasoningEffort: 'light',
      maxStepsPerRun: 64,
      actionCount: 2,
      tags: ['coding'],
    })
  })

  it('tolerates a minimal agent', () => {
    const list = parseAgentList(
      { agentConfigurations: [{ sId: 'a1', name: 'Solo' }] },
      'GET /agents',
    )
    expect(list.agents[0]).toMatchObject({
      sId: 'a1',
      name: 'Solo',
      userFavorite: false,
      actionCount: 0,
      tags: [],
    })
    expect(list.agents[0].modelId).toBeUndefined()
  })

  it('accepts plain string tags', () => {
    const list = parseAgentList(
      { agentConfigurations: [{ sId: 'a1', name: 'Solo', tags: ['ops', ''] }] },
      'GET /agents',
    )
    expect(list.agents[0].tags).toEqual(['ops'])
  })

  it('rejects a payload without the agent list', () => {
    expect(() => parseAgentList({ agents: [] }, 'GET /agents')).toThrow(ProxyError)
  })
})
