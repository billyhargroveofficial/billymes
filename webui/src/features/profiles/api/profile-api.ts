import {
  ApiPayloadError,
  expectArray,
  expectRecord,
  expectString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type {
  GatewayPlatformStatus,
  Profile,
  ProfileAgentSettingsPatch,
  ProfileConfig,
  StatusPayload,
} from '../model/types'

function stringOr(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function booleanOr(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function numberOr(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nullableString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function parseReasoningEffort(value: unknown) {
  if (value === false) return 'none'
  if (value == null || value === '') return ''
  return expectString(value, 'profile config.agent.reasoning_effort')
}

function parseServiceTier(value: unknown) {
  if (value == null || value === '') return ''
  return expectString(value, 'profile config.agent.service_tier')
}

function parseProfileConfig(value: unknown): ProfileConfig {
  const payload = expectRecord(value, 'profile config response')
  const modelValue = payload.model
  const model =
    typeof modelValue === 'string'
      ? modelValue
      : modelValue == null
        ? ''
        : parseModelConfig(modelValue)
  const agent = payload.agent == null ? {} : expectRecord(payload.agent, 'profile config.agent')
  return {
    model,
    agent: {
      reasoning_effort: parseReasoningEffort(agent.reasoning_effort),
      service_tier: parseServiceTier(agent.service_tier),
    },
  }
}

function parseModelConfig(value: unknown) {
  const row = expectRecord(value, 'profile config.model')
  return expectString(row.default ?? row.name, 'profile config.model.default')
}

function parseMutationResult(value: unknown) {
  const row = expectRecord(value, 'profile config mutation response')
  return { ok: typeof row.ok === 'boolean' ? row.ok : true }
}

function parseProfile(value: unknown, index: number): Profile {
  const row = expectRecord(value, `profiles[${index}]`)
  const name = expectString(row.name, `profiles[${index}].name`)
  return {
    name,
    path: stringOr(row.path),
    is_default: booleanOr(row.is_default),
    model: nullableString(row.model),
    provider: nullableString(row.provider),
    has_env: booleanOr(row.has_env),
    skill_count: numberOr(row.skill_count),
    gateway_running: booleanOr(row.gateway_running),
    description: stringOr(row.description),
    display_name: stringOr(row.display_name, name),
  }
}

function parseProfiles(value: unknown) {
  const payload = expectRecord(value, 'profiles response')
  return {
    profiles: expectArray(payload.profiles, 'profiles response.profiles').map(parseProfile),
  }
}

function parseGatewayPlatforms(value: unknown) {
  const input = expectRecord(value, 'status.gateway_platforms')
  const platforms: Record<string, GatewayPlatformStatus> = {}
  for (const [name, raw] of Object.entries(input)) {
    const row = expectRecord(raw, `status.gateway_platforms.${name}`)
    platforms[name] = {
      state: stringOr(row.state, 'unknown'),
      error_message: nullableString(row.error_message),
    }
  }
  return platforms
}

function parseStatus(value: unknown): StatusPayload {
  const payload = expectRecord(value, 'status response')
  const profileNames = expectArray(payload.profiles ?? [], 'status.profiles')
  if (!profileNames.every((item) => typeof item === 'string')) {
    throw new ApiPayloadError('status.profiles[]')
  }
  return {
    version: stringOr(payload.version),
    gateway_running: booleanOr(payload.gateway_running),
    gateway_state: stringOr(payload.gateway_state, 'unknown'),
    gateway_platforms: parseGatewayPlatforms(payload.gateway_platforms ?? {}),
    active_sessions: numberOr(payload.active_sessions),
    profiles: profileNames,
    auth_required: booleanOr(payload.auth_required),
  }
}

export const profileApi = {
  status: async () => parseStatus(await requestJson('/api/status')),
  profiles: async () => parseProfiles(await requestJson('/api/profiles')),
  config: async (name: string) =>
    parseProfileConfig(await requestJson(withProfile('/api/config', name))),
  updateSettings: async (name: string, settings: ProfileAgentSettingsPatch) =>
    parseMutationResult(
      await requestJson(withProfile('/api/config', name), {
        method: 'PUT',
        body: JSON.stringify({ config: { agent: settings } }),
      }),
    ),
  soul: async (name: string) => {
    const data = await requestJson(`/api/profiles/${encodeURIComponent(name)}/soul`)
    if (typeof data === 'string') return { content: data }
    const record = expectRecord(data, 'profile soul')
    const content = record.content ?? record.soul ?? record.text
    return {
      content: typeof content === 'string' ? content : JSON.stringify(data, null, 2),
    }
  },
}
