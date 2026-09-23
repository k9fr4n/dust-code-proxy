import { ModelMapping } from './config.js'
import { DustAgentConfig } from './dust/parse.js'
import { ProxyError } from './errors.js'

// Resolves a Claude Code `model` identifier into a Dust agent `configurationId`
// (the `sId` of an agent). The model field is a routing id, never proof that Dust
// actually ran a specific Anthropic model.
export class ModelRouter {
  private agentsBySid = new Map<string, DustAgentConfig>()
  private agentsByName = new Map<string, DustAgentConfig>()

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
  }

  resolve(model: string): string {
    const mapped = this.mapping[model]
    if (mapped?.configurationId) {
      const id = mapped.configurationId
      if (this.agentsBySid.size > 0 && !this.agentsBySid.has(id)) {
        throw new ProxyError(
          'not_found_error',
          `Mapped Dust agent "${id}" (for model "${model}") does not exist in the workspace.`,
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
  // `proxyctl agents` to show the mapping next to each agent.
  modelsForAgent(sId: string): string[] {
    return Object.entries(this.mapping)
      .filter(([, mapped]) => mapped?.configurationId === sId)
      .map(([model]) => model)
  }

  missingMappedIds(): string[] {
    const missing: string[] = []
    for (const [model, mapped] of Object.entries(this.mapping)) {
      if (
        mapped?.configurationId &&
        this.agentsBySid.size > 0 &&
        !this.agentsBySid.has(mapped.configurationId)
      ) {
        missing.push(`${model} -> ${mapped.configurationId}`)
      }
    }
    return missing
  }
}
