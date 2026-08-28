export type AuxTask = {
  task: string
  provider: string
  model: string
  base_url: string
}

export type ModelOption = {
  id: string
  name?: string
  context_window?: number
  supports_reasoning?: boolean
}

export type ModelCapability = {
  fast: boolean
  reasoning: boolean
  can_disable_reasoning?: boolean
}

export type ProviderOption = {
  slug: string
  name: string
  is_current: boolean
  authenticated: boolean
  models: Array<string | ModelOption>
  total_models?: number
  capabilities?: Record<string, ModelCapability>
  /** Gateway-provided caveat, e.g. how the MoA virtual provider behaves. */
  warning?: string
}

export type ModelInfoCapabilities = {
  supports_tools?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  context_window?: number
  max_output_tokens?: number
  model_family?: string
}

export type ModelInfo = {
  model: string
  provider: string
  effective_context_length: number
  capabilities: ModelInfoCapabilities
}
