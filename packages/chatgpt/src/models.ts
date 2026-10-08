/** Official OpenAI Responses models whose input limits are documented here.
 *
 * Model facts come from the official API model catalog and exact model pages:
 * https://developers.openai.com/api/docs/models
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/models/gpt-6-luna
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ReasoningEffortId as ReasoningEffortIdType,
} from '@deepseek-ai/dsh-llm'

const ADDITIONAL_TOOL_UPDATE = 'addition-only' as const

/** Static facts taken from the official OpenAI API model catalog. */
export interface OfficialOpenAiModel {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly contextWindow: number
  readonly inputModalities: readonly ModelModality[]
  readonly reasoningEfforts: readonly ReasoningEffortIdType[]
}

const modalities = ['text', 'image'] as const satisfies readonly ModelModality[]

/** Exact model IDs and published capabilities; no date aliases are inferred. */
export const OFFICIAL_OPENAI_MODELS: readonly OfficialOpenAiModel[] = Object.freeze([
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    description: 'Our most capable model for the most demanding work.',
    contextWindow: 1_050_000,
    inputModalities: modalities,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(ReasoningEffortId),
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    description: 'Near-Astra performance for complex work at a lower cost.',
    contextWindow: 1_050_000,
    inputModalities: modalities,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(ReasoningEffortId),
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    description: 'Our most efficient model for focused, high-volume tasks.',
    contextWindow: 1_050_000,
    inputModalities: modalities,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'].map(ReasoningEffortId),
  },
])

const officialById = new Map(OFFICIAL_OPENAI_MODELS.map(model => [model.id, model]))

/** Resolve documented facts for one exact official model ID. */
export function officialOpenAiModel(model: string): OfficialOpenAiModel | undefined {
  return officialById.get(model)
}

/** Build list metadata for one exact model route. */
export function toOpenAiModelInfo(provider: string, model: OfficialOpenAiModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: model.inputModalities,
  }
}

/** Build resolved DSH capabilities without materializing a generation default. */
export function toOpenAiResolvedModelInfo(provider: string, model: OfficialOpenAiModel): LlmResolvedModelInfo {
  return {
    ...toOpenAiModelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    reasoning: {
      efforts: model.reasoningEfforts.map(id => ({ id, name: String(id) })),
    },
    toolUpdate: ADDITIONAL_TOOL_UPDATE,
  }
}
