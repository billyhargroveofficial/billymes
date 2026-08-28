import {
  expectArray,
  expectRecord,
  expectString,
  optionalString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type {
  McpServer,
  Skill,
  Toolset,
  ToolsetConfig,
  ToolsetModels,
  ToolsetProvider,
} from '../model/types'

function booleanOr(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function numberOr(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function strings(value: unknown, label: string) {
  return expectArray(value ?? [], label).map((item, index) =>
    expectString(item, `${label}[${index}]`),
  )
}

function parseSkill(value: unknown, index: number): Skill {
  const label = `skills[${index}]`
  const row = expectRecord(value, label)
  return {
    name: expectString(row.name, `${label}.name`),
    description: typeof row.description === 'string' ? row.description : '',
    category: typeof row.category === 'string' ? row.category : '',
    enabled: booleanOr(row.enabled),
    usage: numberOr(row.usage),
    provenance: typeof row.provenance === 'string' ? row.provenance : '',
  }
}

function parseToolset(value: unknown, index: number): Toolset {
  const label = `toolsets[${index}]`
  const row = expectRecord(value, label)
  return {
    name: expectString(row.name, `${label}.name`),
    label: typeof row.label === 'string' ? row.label : '',
    description: typeof row.description === 'string' ? row.description : '',
    platform: typeof row.platform === 'string' ? row.platform : '',
    platform_label: typeof row.platform_label === 'string' ? row.platform_label : '',
    enabled: booleanOr(row.enabled),
    available: booleanOr(row.available),
    configured: booleanOr(row.configured),
    tools: strings(row.tools, `${label}.tools`),
  }
}

function parseProvider(value: unknown, index: number): ToolsetProvider {
  const label = `toolset config.providers[${index}]`
  const row = expectRecord(value, label)
  return {
    name: expectString(row.name, `${label}.name`),
    badge: typeof row.badge === 'string' ? row.badge : '',
    tag: typeof row.tag === 'string' ? row.tag : '',
    postSetup: optionalString(row.post_setup, `${label}.post_setup`),
    requiresNousAuth: booleanOr(row.requires_nous_auth),
    isActive: booleanOr(row.is_active),
    status: typeof row.status === 'string' ? row.status : 'unknown',
    capabilities: strings(row.capabilities, `${label}.capabilities`),
    webBackend: optionalString(row.web_backend, `${label}.web_backend`),
    ttsProvider: optionalString(row.tts_provider, `${label}.tts_provider`),
    envVars: expectArray(row.env_vars ?? [], `${label}.env_vars`).map((value, envIndex) => {
      const envLabel = `${label}.env_vars[${envIndex}]`
      const env = expectRecord(value, envLabel)
      return {
        key: expectString(env.key, `${envLabel}.key`),
        prompt: typeof env.prompt === 'string' ? env.prompt : '',
        url: optionalString(env.url, `${envLabel}.url`),
        isSet: booleanOr(env.is_set),
        hasDefault: env.default != null && env.default !== '',
      }
    }),
  }
}

export function parseToolsetConfigPayload(value: unknown): ToolsetConfig {
  const row = expectRecord(value, 'toolset config')
  return {
    name: expectString(row.name, 'toolset config.name'),
    hasCategory: booleanOr(row.has_category),
    activeProvider: optionalString(row.active_provider, 'toolset config.active_provider'),
    activeSearchBackend: optionalString(
      row.active_search_backend,
      'toolset config.active_search_backend',
    ),
    activeExtractBackend: optionalString(
      row.active_extract_backend,
      'toolset config.active_extract_backend',
    ),
    providers: expectArray(row.providers ?? [], 'toolset config.providers').map(parseProvider),
  }
}

export function parseToolsetModelsPayload(value: unknown): ToolsetModels {
  const row = expectRecord(value, 'toolset models')
  return {
    name: expectString(row.name, 'toolset models.name'),
    hasModels: booleanOr(row.has_models),
    provider: optionalString(row.provider, 'toolset models.provider'),
    plugin: optionalString(row.plugin, 'toolset models.plugin'),
    current: optionalString(row.current, 'toolset models.current'),
    default: optionalString(row.default, 'toolset models.default'),
    models: expectArray(row.models ?? [], 'toolset models.models').map((value, index) => {
      const label = `toolset models.models[${index}]`
      const model = expectRecord(value, label)
      return {
        id: expectString(model.id, `${label}.id`),
        display: typeof model.display === 'string' ? model.display : '',
        speed: typeof model.speed === 'string' ? model.speed : '',
        strengths: typeof model.strengths === 'string' ? model.strengths : '',
        price: typeof model.price === 'string' ? model.price : '',
      }
    }),
  }
}

function parseMcp(value: unknown) {
  const payload = expectRecord(value, 'MCP response')
  return {
    servers: expectArray(payload.servers, 'MCP response.servers').map((value, index): McpServer => {
      const label = `MCP response.servers[${index}]`
      const row = expectRecord(value, label)
      const rawTools = row.tools == null ? null : strings(row.tools, `${label}.tools`)
      return {
        name: expectString(row.name, `${label}.name`),
        transport: typeof row.transport === 'string' ? row.transport : '',
        url: optionalString(row.url, `${label}.url`),
        command: optionalString(row.command, `${label}.command`),
        args: strings(row.args, `${label}.args`),
        enabled: booleanOr(row.enabled),
        tools: rawTools,
        auth: optionalString(row.auth, `${label}.auth`),
      }
    }),
  }
}

export const catalogApi = {
  skills: async (profile?: string) =>
    expectArray(await requestJson(withProfile('/api/skills', profile)), 'skills').map(parseSkill),
  skillContent: async (name: string, profile?: string) => {
    const payload = expectRecord(
      await requestJson(
        withProfile(`/api/skills/content?name=${encodeURIComponent(name)}`, profile),
      ),
      'skill content',
    )
    return {
      name: typeof payload.name === 'string' ? payload.name : name,
      content: expectString(payload.content, 'skill content.content'),
    }
  },
  toggleSkill: (name: string, enabled: boolean, profile?: string) =>
    requestJson(withProfile('/api/skills/toggle', profile), {
      method: 'PUT',
      body: JSON.stringify({ name, enabled, profile }),
    }),
  toolsets: async (profile?: string) =>
    expectArray(await requestJson(withProfile('/api/tools/toolsets', profile)), 'toolsets').map(
      parseToolset,
    ),
  toggleToolset: (name: string, enabled: boolean, profile?: string) =>
    requestJson(withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}`, profile), {
      method: 'PUT',
      body: JSON.stringify({ enabled, profile }),
    }),
  toolsetConfig: async (name: string, profile?: string) =>
    parseToolsetConfigPayload(
      await requestJson(
        withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}/config`, profile),
      ),
    ),
  toolsetModels: async (name: string, provider?: string | null, profile?: string) => {
    const path = `/api/tools/toolsets/${encodeURIComponent(name)}/models`
    const withProvider = provider ? `${path}?provider=${encodeURIComponent(provider)}` : path
    return parseToolsetModelsPayload(await requestJson(withProfile(withProvider, profile)))
  },
  selectToolsetProvider: (
    name: string,
    provider: string,
    capability?: 'search' | 'extract',
    profile?: string,
  ) =>
    requestJson(withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}/provider`, profile), {
      method: 'PUT',
      body: JSON.stringify({ provider, capability, profile }),
    }),
  selectToolsetModel: (name: string, model: string, provider?: string | null, profile?: string) =>
    requestJson(withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}/model`, profile), {
      method: 'PUT',
      body: JSON.stringify({ model, provider, profile }),
    }),
  usage: async (profile?: string, days = 90) => {
    const payload = expectRecord(
      await requestJson(withProfile(`/api/analytics/usage?days=${days}`, profile)),
      'analytics usage',
    )
    return {
      tools: expectArray(payload.tools, 'analytics usage.tools').map((value, index) => {
        const row = expectRecord(value, `analytics usage.tools[${index}]`)
        return {
          tool: expectString(row.tool, `analytics usage.tools[${index}].tool`),
          count: numberOr(row.count),
          percentage: numberOr(row.percentage),
        }
      }),
    }
  },
  mcp: async (profile?: string) =>
    parseMcp(await requestJson(withProfile('/api/mcp/servers', profile))),
  testMcp: (name: string, profile?: string) =>
    requestJson(withProfile(`/api/mcp/servers/${encodeURIComponent(name)}/test`, profile), {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),
  toggleMcp: (name: string, enabled: boolean, profile?: string) =>
    requestJson(withProfile(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, profile), {
      method: 'PUT',
      body: JSON.stringify({ enabled, profile }),
    }),
}
