import { z } from 'zod'
import { ProxyError } from '../errors.js'

// Workspace agent list.
//
// The public API (`GET /api/v1/w/{wId}/assistant/agent_configurations`, used by
// `DustClient.listAgents` for model routing) returns little more than a name and
// an `sId`. The web app reads the manage view instead,
// `GET /api/w/{wId}/assistant/agent_configurations?view=manage`: undocumented,
// but it accepts the same WorkOS bearer token as the public API, needs no admin
// role, and carries what is needed to fill `models.json` — scope, status and the
// LLM each agent actually runs.
//
// Observed payload (eu.dust.tt):
//
//   { "agentConfigurations": [
//       { "sId": "ggKOhTwS8Y", "name": "Claude_4.5_Haiku", "version": 0,
//         "versionCreatedAt": "2026-08-17T14:07:29.223Z", "scope": "hidden",
//         "status": "active", "description": "…", "userFavorite": false,
//         "model": { "providerId": "anthropic", "modelId": "claude-haiku-4-5-20251001",
//                    "temperature": 0.7, "reasoningEffort": "light" },
//         "actions": [], "maxStepsPerRun": 64, "tags": [],
//         "canRead": true, "canEdit": true } ] }
//
// `scope` is `global` for the agents Dust ships with (@help, …), `visible` for
// the ones published to the workspace and `hidden` for unpublished/personal
// ones. Hidden agents are perfectly usable as a routing target: the
// Claude_* agents this proxy maps are exactly those.

export const AGENTS_PATH = '/api/w/{ws}/assistant/agent_configurations?view=manage'

export interface DustAgentDetail {
  sId: string
  name: string
  description?: string
  scope?: string
  status?: string
  userFavorite: boolean
  canEdit?: boolean
  version?: number
  versionCreatedAt?: string
  providerId?: string
  modelId?: string
  temperature?: number
  reasoningEffort?: string
  maxStepsPerRun?: number
  actionCount: number
  tags: string[]
}

export interface AgentList {
  source: string
  agents: DustAgentDetail[]
}

// Only `sId` and `name` are required: everything else is display sugar and must
// not make the command fail if Dust renames or drops it.
const agentSchema = z.object({
  sId: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  scope: z.string().nullish(),
  status: z.string().nullish(),
  userFavorite: z.boolean().nullish(),
  canEdit: z.boolean().nullish(),
  version: z.number().nullish(),
  versionCreatedAt: z.string().nullish(),
  model: z
    .object({
      providerId: z.string().nullish(),
      modelId: z.string().nullish(),
      temperature: z.number().nullish(),
      reasoningEffort: z.string().nullish(),
    })
    .nullish(),
  actions: z.array(z.unknown()).nullish(),
  maxStepsPerRun: z.number().nullish(),
  tags: z
    .array(z.union([z.string(), z.object({ name: z.string().nullish() })]))
    .nullish(),
})

const responseSchema = z.object({
  agentConfigurations: z.array(agentSchema),
})

type RawAgent = z.infer<typeof agentSchema>

function toAgent(raw: RawAgent): DustAgentDetail {
  return {
    sId: raw.sId,
    name: raw.name,
    description: raw.description ?? undefined,
    scope: raw.scope ?? undefined,
    status: raw.status ?? undefined,
    userFavorite: raw.userFavorite ?? false,
    canEdit: raw.canEdit ?? undefined,
    version: raw.version ?? undefined,
    versionCreatedAt: raw.versionCreatedAt ?? undefined,
    providerId: raw.model?.providerId ?? undefined,
    modelId: raw.model?.modelId ?? undefined,
    temperature: raw.model?.temperature ?? undefined,
    reasoningEffort: raw.model?.reasoningEffort ?? undefined,
    maxStepsPerRun: raw.maxStepsPerRun ?? undefined,
    actionCount: raw.actions?.length ?? 0,
    tags: (raw.tags ?? [])
      .map((t) => (typeof t === 'string' ? t : t.name ?? ''))
      .filter(Boolean),
  }
}

export function parseAgentList(json: unknown, source: string): AgentList {
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProxyError(
      'api_error',
      `Unexpected agent payload from Dust (${source}): ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      502,
    )
  }
  return {
    source,
    agents: parsed.data.agentConfigurations.map(toAgent),
  }
}
