export type Skill = {
  name: string
  description: string
  category: string
  enabled: boolean
  usage: number
  provenance: string
}

export type Toolset = {
  name: string
  label: string
  description: string
  platform: string
  platform_label: string
  enabled: boolean
  available: boolean
  configured: boolean
  tools: string[]
}

type ToolsetProviderEnv = {
  key: string
  prompt: string
  url: string | null
  isSet: boolean
  hasDefault: boolean
}

export type ToolsetProvider = {
  name: string
  badge: string
  tag: string
  postSetup: string | null
  requiresNousAuth: boolean
  isActive: boolean
  status: string
  capabilities: string[]
  webBackend: string | null
  ttsProvider: string | null
  envVars: ToolsetProviderEnv[]
}

export type ToolsetConfig = {
  name: string
  hasCategory: boolean
  activeProvider: string | null
  activeSearchBackend: string | null
  activeExtractBackend: string | null
  providers: ToolsetProvider[]
}

type ToolsetModel = {
  id: string
  display: string
  speed: string
  strengths: string
  price: string
}

export type ToolsetModels = {
  name: string
  hasModels: boolean
  provider: string | null
  plugin: string | null
  current: string | null
  default: string | null
  models: ToolsetModel[]
}

export type McpServer = {
  name: string
  transport: string
  url: string | null
  command: string | null
  args: string[]
  enabled: boolean
  tools: string[] | null
  auth: string | null
}

/** One row of `GET /api/analytics/usage` → `tools`. */
export type ToolUsage = {
  count: number
  percentage: number
}

/**
 * The slice of the Hermes agent configuration the tools screen reads and
 * writes. `GET /api/config` returns the whole document; we keep only the keys
 * that drive tool policy so an unrelated key can never leak into a write.
 */
export type ToolPolicyConfig = {
  /** `platform_toolsets.<platform>` — toolset keys served to that platform. */
  platformToolsets: Record<string, string[]>
  /** `known_builtin_toolsets.<platform>` — catalog Hermes recorded per platform. */
  knownBuiltinToolsets: Record<string, string[]>
  /** `known_plugin_toolsets.<platform>` — plugin-provided keys per platform. */
  knownPluginToolsets: Record<string, string[]>
  /** `agent.disabled_toolsets` — user-level deny list applied after everything. */
  disabledToolsets: string[]
  /** `tools.tool_search` */
  toolSearch: Record<string, string | number>
  /** `tool_output` */
  toolOutput: Record<string, string | number>
  /** `terminal.backend` */
  terminalBackend: string | null
}

/** One field of `GET /api/config/schema` → `fields`, keyed by its dotted path. */
export type ConfigField = {
  path: string
  type: string
  description: string
  options: string[]
}

export type MessagingPlatform = {
  id: string
  name: string
  enabled: boolean
  configured: boolean
  state: string
}

type TerminalBackend = {
  name: string
  label: string
  description: string
  active: boolean
  status: string
  detail: string
}

export type TerminalBackends = {
  active: string
  backends: TerminalBackend[]
}

type ComputerUseCheck = {
  label: string
  status: string
  message: string
}

export type ComputerUseStatus = {
  platform: string
  platformSupported: boolean
  installed: boolean
  version: string | null
  ready: boolean
  canGrant: boolean
  checks: ComputerUseCheck[]
}

/** `GET /api/actions/tools-post-setup/status` — the install hook's tail. */
export type ActionStatus = {
  running: boolean
  exitCode: number | null
  lines: string[]
}
