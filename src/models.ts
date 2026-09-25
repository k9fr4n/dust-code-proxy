import { ModelMapping } from './config.js'
import { DustAgentConfig } from './dust/parse.js'
import { ProxyError } from './errors.js'

// Resolves a Claude Code `model` identifier into a Dust agent `configurationId`
// (the `sId` of an agent). The model field is a routing id, never proof that Dust
// actually ran a specific Anthropic model.
export class ModelRouter {
  private agentsBySid = new Map<string, DustAgentConfig>()
  private agentsByName = new Map<string, DustAgentConfig>()
  private agentsByModelId = new Map<string, DustAgentConfig[]>()

  constructor(
    private readonly mapping: ModelMapping,
    private readonly defaultAgentConfigurationId?: string,
  ) {}

  setAgents(agents: DustAgentConfig[]): void {
    this.agentsBySid = new Map(agents.map((a) => [a.sId, a]))
    this.agentsByName = new Map()
    for (const agent of agents) {
      this.agentsByName.set(agent.name.toLowerCase(), agent)
      this.agentsByName.set(agent.sId.toLowerCase(), agent)
    }
    this.agentsByModelId = new Map()
    for (const agent of agents) {
      if (!agent.modelId) continue
      const key = agent.modelId.toLowerCase()
      const bucket = this.agentsByModelId.get(key)
      if (bucket) bucket.push(agent)
      else this.agentsByModelId.set(key, [agent])
    }
  }

  // Resolve a `configurationId` from models.json into a concrete agent sId. It may
  // be an sId (unchanged), an agent name, or a modelId shared by several agents.
  // Returns `undefined` when nothing matches; `resolve` turns that into an error.
  private resolveConfigurationId(id: string): string | undefined {
    // No agent list loaded yet: pass through and let Dust validate the mention.
    if (this.agentsBySid.size === 0) return id
    if (this.agentsBySid.has(id)) return id
    const byName = this.agentsByName.get(id.toLowerCase())
    if (byName) return byName.sId
    const byModel = this.agentsByModelId.get(id.toLowerCase())
    if (byModel?.length) return preferredAgent(byModel).sId
    return undefined
  }

  resolve(model: string): string {
    const mapped = this.mapping[model]
    if (mapped?.configurationId) {
      const id = this.resolveConfigurationId(mapped.configurationId)
      if (!id) {
        throw new ProxyError(
          'not_found_error',
          `Mapped Dust agent "${mapped.configurationId}" (for model "${model}") does not exist in the workspace.`,
          404,
        )
      }
      return id
    }
    if (this.defaultAgentConfigurationId) {
      // Resolve a display name (e.g. "Claude_Sonnet_5") to its real sId, since Dust
      // silently rejects a mention whose `configurationId` is a name rather than an
      // sId — which leaves the conversation without any agent message.
      const agent = this.agentsByName.get(this.defaultAgentConfigurationId.toLowerCase())
      return agent?.sId ?? this.defaultAgentConfigurationId
    }
    const byName = this.agentsByName.get(model.toLowerCase())
    if (byName) return byName.sId
    // Fall back to the provider modelId: lets a catalog id (e.g. claude-opus-4-8)
    // route to the agent running that model even without a models.json entry.
    const byModel = this.agentsByModelId.get(model.toLowerCase())
    if (byModel?.length) return preferredAgent(byModel).sId
    throw new ProxyError(
      'not_found_error',
      `No Dust agent configured for model "${model}". Add it to models.json or set DUST_DEFAULT_AGENT_CONFIGURATION_ID.`,
      404,
    )
  }

  listModels(): string[] {
    const ids = new Set<string>(Object.keys(this.mapping))
    for (const agent of this.agentsBySid.values()) ids.add(agent.sId)
    return [...ids]
  }

  // Claude Code model names that route to a given Dust agent. Used by
  // `proxyctl agents` to show the mapping next to each agent. A mapping whose
  // `configurationId` is a modelId (or a name) counts for every agent it resolves
  // to, so the column matches the actual routing.
  modelsForAgent(sId: string): string[] {
    return Object.entries(this.mapping)
      .filter(([, mapped]) => {
        const id = mapped?.configurationId
        if (!id) return false
        return this.resolveConfigurationId(id) === sId
      })
      .map(([model]) => model)
  }

  missingMappedIds(): string[] {
    if (this.agentsBySid.size === 0) return []
    const missing: string[] = []
    for (const [model, mapped] of Object.entries(this.mapping)) {
      if (mapped?.configurationId && !this.resolveConfigurationId(mapped.configurationId)) {
        missing.push(`${model} -> ${mapped.configurationId}`)
      }
    }
    return missing
  }
}

// Deterministic pick among agents sharing a modelId: active beats archived, then
// personal (hidden) beats shared/global, then favorites, then the smallest sId so
// the result is stable across refreshes.
function preferredAgent(candidates: DustAgentConfig[]): DustAgentConfig {
  const rank = (a: DustAgentConfig): number =>
    (a.status !== 'archived' ? 1 : 0) * 1000 +
    (a.scope === 'hidden' ? 1 : 0) * 100 +
    (a.userFavorite ? 1 : 0) * 10
  return [...candidates].sort(
    (a, b) => rank(b) - rank(a) || a.sId.localeCompare(b.sId),
  )[0]
}
