export type Profile = {
  name: string
  path: string
  is_default: boolean
  model: string | null
  provider: string | null
  has_env: boolean
  skill_count: number
  gateway_running: boolean
  description: string
  display_name: string
}

type ProfileAgentSettings = {
  reasoning_effort: string
  service_tier: string
}

export type ProfileConfig = {
  model: string
  agent: ProfileAgentSettings
}

export type ProfileAgentSettingsPatch = {
  reasoning_effort?: string
  service_tier?: string
}

export type GatewayPlatformStatus = {
  state: string
  error_message?: string | null
}

export type StatusPayload = {
  version: string
  gateway_running: boolean
  gateway_state: string
  gateway_platforms: Record<string, GatewayPlatformStatus>
  active_sessions: number
  profiles: string[]
  auth_required: boolean
}
