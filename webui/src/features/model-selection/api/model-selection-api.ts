import {
  ApiPayloadError,
  expectArray,
  expectBoolean,
  expectRecord,
  expectString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type {
  AuxTask,
  ModelCapability,
  ModelInfo,
  ModelInfoCapabilities,
  ModelOption,
  ProviderOption,
} from '../model/types'

function optionalFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseModel(value: unknown, label: string): string | ModelOption {
  if (typeof value === 'string') return value
  const row = expectRecord(value, label)
  const contextWindow = optionalFiniteNumber(row.context_window)
  return {
    id: expectString(row.id, `${label}.id`),
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    ...(typeof row.supports_reasoning === 'boolean'
      ? { supports_reasoning: row.supports_reasoning }
      : {}),
  }
}

function parseProvider(value: unknown, index: number): ProviderOption {
  const label = `model options.providers[${index}]`
  const row = expectRecord(value, label)
  const models = expectArray(row.models ?? [], `${label}.models`)
  const totalModels = optionalFiniteNumber(row.total_models)
  const capabilities =
    row.capabilities === undefined
      ? undefined
      : parseCapabilities(row.capabilities, `${label}.capabilities`)
  return {
    slug: expectString(row.slug, `${label}.slug`),
    name: expectString(row.name, `${label}.name`),
    is_current: expectBoolean(row.is_current, `${label}.is_current`),
    authenticated: expectBoolean(row.authenticated, `${label}.authenticated`),
    models: models.map((item, modelIndex) => parseModel(item, `${label}.models[${modelIndex}]`)),
    ...(totalModels === undefined ? {} : { total_models: totalModels }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(typeof row.warning === 'string' && row.warning ? { warning: row.warning } : {}),
  }
}

function parseCapabilities(value: unknown, label: string): Record<string, ModelCapability> {
  const input = expectRecord(value, label)
  const capabilities: Record<string, ModelCapability> = {}
  for (const [model, raw] of Object.entries(input)) {
    const row = expectRecord(raw, `${label}.${model}`)
    const canDisable = row.can_disable_reasoning
    capabilities[model] = {
      fast: expectBoolean(row.fast, `${label}.${model}.fast`),
      reasoning: expectBoolean(row.reasoning, `${label}.${model}.reasoning`),
      ...(canDisable === undefined
        ? {}
        : {
            can_disable_reasoning: expectBoolean(
              canDisable,
              `${label}.${model}.can_disable_reasoning`,
            ),
          }),
    }
  }
  return capabilities
}

function parseModelOptions(value: unknown) {
  const row = expectRecord(value, 'model options response')
  return {
    providers: expectArray(row.providers, 'model options.providers').map(parseProvider),
    model: expectString(row.model, 'model options.model'),
    provider: expectString(row.provider, 'model options.provider'),
  }
}

function parseModelInfo(value: unknown): ModelInfo {
  const row = expectRecord(value, 'model info response')
  const context = row.effective_context_length
  return {
    model: expectString(row.model, 'model info.model'),
    provider: expectString(row.provider, 'model info.provider'),
    effective_context_length:
      typeof context === 'number' && Number.isFinite(context) ? context : 272_000,
    capabilities: parseModelInfoCapabilities(row.capabilities ?? {}),
  }
}

function parseModelInfoCapabilities(value: unknown): ModelInfoCapabilities {
  const row = expectRecord(value, 'model info.capabilities')
  const supportsTools = row.supports_tools
  const supportsVision = row.supports_vision
  const supportsReasoning = row.supports_reasoning
  const contextWindow = row.context_window
  const maxOutputTokens = row.max_output_tokens
  const modelFamily = row.model_family
  return {
    ...(supportsTools === undefined
      ? {}
      : { supports_tools: expectBoolean(supportsTools, 'model info.capabilities.supports_tools') }),
    ...(supportsVision === undefined
      ? {}
      : {
          supports_vision: expectBoolean(supportsVision, 'model info.capabilities.supports_vision'),
        }),
    ...(supportsReasoning === undefined
      ? {}
      : {
          supports_reasoning: expectBoolean(
            supportsReasoning,
            'model info.capabilities.supports_reasoning',
          ),
        }),
    ...(contextWindow === undefined
      ? {}
      : { context_window: finiteNumber(contextWindow, 'model info.capabilities.context_window') }),
    ...(maxOutputTokens === undefined
      ? {}
      : {
          max_output_tokens: finiteNumber(
            maxOutputTokens,
            'model info.capabilities.max_output_tokens',
          ),
        }),
    ...(modelFamily === undefined
      ? {}
      : { model_family: expectString(modelFamily, 'model info.capabilities.model_family') }),
  }
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiPayloadError(label)
  }
  return value
}

function parseAuxiliary(value: unknown) {
  const row = expectRecord(value, 'auxiliary models response')
  const tasks = expectArray(row.tasks, 'auxiliary models.tasks').map((item, index): AuxTask => {
    const task = expectRecord(item, `auxiliary models.tasks[${index}]`)
    return {
      task: expectString(task.task, `auxiliary models.tasks[${index}].task`),
      provider: typeof task.provider === 'string' ? task.provider : '',
      model: typeof task.model === 'string' ? task.model : '',
      base_url: typeof task.base_url === 'string' ? task.base_url : '',
    }
  })
  const main = expectRecord(row.main, 'auxiliary models.main')
  return {
    tasks,
    main: {
      provider: expectString(main.provider, 'auxiliary models.main.provider'),
      model: expectString(main.model, 'auxiliary models.main.model'),
    },
  }
}

function parseMutationResult(value: unknown) {
  const row = expectRecord(value, 'model mutation response')
  return {
    ok: typeof row.ok === 'boolean' ? row.ok : true,
    ...(typeof row.warning === 'string' ? { warning: row.warning } : {}),
  }
}

export const modelSelectionApi = {
  info: async (profile?: string) =>
    parseModelInfo(await requestJson(withProfile('/api/model/info', profile))),
  options: async (profile?: string) =>
    parseModelOptions(await requestJson(withProfile('/api/model/options', profile))),
  auxiliary: async (profile?: string) =>
    parseAuxiliary(await requestJson(withProfile('/api/model/auxiliary', profile))),
  setProfileMainModel: async (profile: string | undefined, provider: string, model: string) => {
    if (!profile || profile === 'default') {
      return parseMutationResult(
        await requestJson('/api/model/set', {
          method: 'POST',
          body: JSON.stringify({
            scope: 'main',
            provider,
            model,
            confirm_expensive_model: true,
          }),
        }),
      )
    }
    return parseMutationResult(
      await requestJson(`/api/profiles/${encodeURIComponent(profile)}/model`, {
        method: 'PUT',
        body: JSON.stringify({ provider, model }),
      }),
    )
  },
}
