import { z } from 'zod'
import { ProxyError } from '../errors.js'

// Workspace model catalog.
//
// Same situation as `credits.ts`: the public API (v1) exposes no list of the
// LLMs a workspace may run. The web app reads it from
// `GET /api/w/{wId}/models`: undocumented, but it accepts the same WorkOS
// bearer token as the public API and needs no admin role.
//
// Observed payload (eu.dust.tt):
//
//   { "models": [ { "providerId": "anthropic", "modelId": "claude-opus-5",
//                   "displayName": "Claude Opus 5", "contextSize": 250000,
//                   "generationTokensCount": 64000, "isLatest": false,
//                   "isLegacy": false, "isSelectable": true, … } ],
//     "defaultModel": { … },
//     "streams": { "auto": { "providerId": "openai", "modelId": "gpt-5.6-luna",
//                            "reasoningEffort": "high" } },
//     "degradedModelIds": [] }
//
// The `auto` / `auto_fast` / `auto_complex` entries are Dust's routing tiers,
// not real models: `streams` says which concrete model each one currently
// resolves to.
//
// This is the *provider* catalog, unrelated to `models.json`, which maps the
// model names Claude Code sends to Dust agent configurations.

export const MODELS_PATH = '/api/w/{ws}/models'

export interface DustModel {
  providerId: string
  modelId: string
  displayName?: string
  description?: string
  contextSize?: number
  maxOutputTokens?: number
  largeModel?: boolean
  isLatest?: boolean
  isLegacy?: boolean
  isSelectable?: boolean
  supportsVision?: boolean
  reasoningEfforts: string[]
  defaultReasoningEffort?: string
  degraded: boolean
}

export interface DustStream {
  stream: string
  providerId: string
  modelId: string
  displayName?: string
  reasoningEffort?: string
}

export interface ModelCatalog {
  source: string
  models: DustModel[]
  defaultModel?: DustModel
  streams: DustStream[]
}

// Only the identity fields are required: everything else is display sugar and
// must not make the command fail if Dust renames or drops it.
const modelSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string().nullish(),
  shortDescription: z.string().nullish(),
  description: z.string().nullish(),
  contextSize: z.number().nullish(),
  generationTokensCount: z.number().nullish(),
  largeModel: z.boolean().nullish(),
  isLatest: z.boolean().nullish(),
  isLegacy: z.boolean().nullish(),
  isSelectable: z.boolean().nullish(),
  supportsVision: z.boolean().nullish(),
  supportedReasoningEfforts: z.record(z.string(), z.boolean()).nullish(),
  defaultReasoningEffort: z.string().nullish(),
})

const streamSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
})

const responseSchema = z.object({
  models: z.array(modelSchema),
  defaultModel: modelSchema.nullish(),
  streams: z.record(z.string(), streamSchema).nullish(),
  degradedModelIds: z.array(z.string()).nullish(),
})

type RawModel = z.infer<typeof modelSchema>

function toModel(raw: RawModel, degraded: Set<string>): DustModel {
  return {
    providerId: raw.providerId,
    modelId: raw.modelId,
    displayName: raw.displayName ?? undefined,
    description: raw.shortDescription ?? raw.description ?? undefined,
    contextSize: raw.contextSize ?? undefined,
    maxOutputTokens: raw.generationTokensCount ?? undefined,
    largeModel: raw.largeModel ?? undefined,
    isLatest: raw.isLatest ?? undefined,
    isLegacy: raw.isLegacy ?? undefined,
    isSelectable: raw.isSelectable ?? undefined,
    supportsVision: raw.supportsVision ?? undefined,
    reasoningEfforts: Object.entries(raw.supportedReasoningEfforts ?? {})
      .filter(([, supported]) => supported)
      .map(([effort]) => effort),
    defaultReasoningEffort: raw.defaultReasoningEffort ?? undefined,
    degraded: degraded.has(raw.modelId),
  }
}

export function parseModelCatalog(json: unknown, source: string): ModelCatalog {
  const parsed = responseSchema.safeParse(json)
  if (!parsed.success) {
    throw new ProxyError(
      'api_error',
      `Unexpected model payload from Dust (${source}): ${parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      502,
    )
  }
  const degraded = new Set(parsed.data.degradedModelIds ?? [])
  return {
    source,
    models: parsed.data.models.map((m) => toModel(m, degraded)),
    defaultModel: parsed.data.defaultModel
      ? toModel(parsed.data.defaultModel, degraded)
      : undefined,
    streams: Object.entries(parsed.data.streams ?? {}).map(([stream, s]) => ({
      stream,
      providerId: s.providerId,
      modelId: s.modelId,
      displayName: s.displayName ?? undefined,
      reasoningEffort: s.reasoningEffort ?? undefined,
    })),
  }
}
