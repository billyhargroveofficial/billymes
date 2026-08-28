import {
  expectArray,
  expectRecord,
  expectString,
  optionalString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type {
  ActionStatus,
  ComputerUseStatus,
  ConfigField,
  MessagingPlatform,
  TerminalBackends,
  ToolPolicyConfig,
} from '../model/types'

function booleanOr(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Config list values reach us either as a real YAML list or — after a
 * `hermes config set` / JSON-mode editor save — as a stringified array. Hermes
 * itself parses both (`agent.skill_utils.parse_config_string_list`), so the UI
 * has to as well or the deny list looks empty when it is not.
 */
export function parseConfigStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  if (typeof value !== 'string' || !value.trim()) return []
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text.replaceAll("'", '"'))
      if (Array.isArray(parsed)) return parseConfigStringList(parsed)
    } catch {
      /* fall through to the comma form */
    }
  }
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function listsByPlatform(value: unknown): Record<string, string[]> {
  const source = record(value)
  const result: Record<string, string[]> = {}
  for (const [platform, entries] of Object.entries(source)) {
    result[platform] = parseConfigStringList(entries)
  }
  return result
}

/** Keep only scalar leaves — the settings block renders nothing else. */
function scalars(value: unknown): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) {
      result[key] = item
    }
  }
  return result
}

export function parseToolPolicyConfig(value: unknown): ToolPolicyConfig {
  const config = expectRecord(value, 'config')
  const agent = record(config.agent)
  const terminal = record(config.terminal)
  return {
    platformToolsets: listsByPlatform(config.platform_toolsets),
    knownBuiltinToolsets: listsByPlatform(config.known_builtin_toolsets),
    knownPluginToolsets: listsByPlatform(config.known_plugin_toolsets),
    disabledToolsets: parseConfigStringList(agent.disabled_toolsets),
    toolSearch: scalars(record(config.tools).tool_search),
    toolOutput: scalars(config.tool_output),
    terminalBackend: typeof terminal.backend === 'string' ? terminal.backend : null,
  }
}

export function parseConfigSchema(value: unknown): Record<string, ConfigField> {
  const fields = record(expectRecord(value, 'config schema').fields)
  const result: Record<string, ConfigField> = {}
  for (const [path, raw] of Object.entries(fields)) {
    const field = record(raw)
    result[path] = {
      path,
      type: typeof field.type === 'string' ? field.type : 'string',
      description: typeof field.description === 'string' ? field.description : '',
      options: Array.isArray(field.options)
        ? field.options.filter((item): item is string => typeof item === 'string')
        : [],
    }
  }
  return result
}

export function parseMessagingPlatforms(value: unknown): MessagingPlatform[] {
  const payload = expectRecord(value, 'messaging platforms')
  return expectArray(payload.platforms, 'messaging platforms.platforms').map((item, index) => {
    const label = `messaging platforms.platforms[${index}]`
    const row = expectRecord(item, label)
    return {
      id: expectString(row.id, `${label}.id`),
      name: typeof row.name === 'string' ? row.name : '',
      enabled: booleanOr(row.enabled),
      configured: booleanOr(row.configured),
      state: typeof row.state === 'string' ? row.state : '',
    }
  })
}

export function parseTerminalBackends(value: unknown): TerminalBackends {
  const payload = expectRecord(value, 'terminal backends')
  return {
    active: typeof payload.active === 'string' ? payload.active : 'local',
    backends: expectArray(payload.backends ?? [], 'terminal backends.backends').map(
      (item, index) => {
        const label = `terminal backends.backends[${index}]`
        const row = expectRecord(item, label)
        return {
          name: expectString(row.name, `${label}.name`),
          label: typeof row.label === 'string' ? row.label : '',
          description: typeof row.description === 'string' ? row.description : '',
          active: booleanOr(row.active),
          status: typeof row.status === 'string' ? row.status : 'unknown',
          detail: typeof row.detail === 'string' ? row.detail : '',
        }
      },
    ),
  }
}

export function parseComputerUseStatus(value: unknown): ComputerUseStatus {
  const row = expectRecord(value, 'computer use status')
  return {
    platform: typeof row.platform === 'string' ? row.platform : '',
    platformSupported: booleanOr(row.platform_supported),
    installed: booleanOr(row.installed),
    version: optionalString(row.version, 'computer use status.version'),
    ready: booleanOr(row.ready),
    canGrant: booleanOr(row.can_grant),
    checks: expectArray(row.checks ?? [], 'computer use status.checks').map((item, index) => {
      const label = `computer use status.checks[${index}]`
      const check = expectRecord(item, label)
      return {
        label: typeof check.label === 'string' ? check.label : '',
        status: typeof check.status === 'string' ? check.status : '',
        message: typeof check.message === 'string' ? check.message : '',
      }
    }),
  }
}

function parseActionStatus(value: unknown): ActionStatus {
  const row = expectRecord(value, 'action status')
  return {
    running: booleanOr(row.running),
    exitCode: typeof row.exit_code === 'number' ? row.exit_code : null,
    lines: Array.isArray(row.lines)
      ? row.lines.filter((line): line is string => typeof line === 'string')
      : [],
  }
}

export const toolsConfigApi = {
  config: async (profile?: string) =>
    parseToolPolicyConfig(await requestJson(withProfile('/api/config', profile))),

  /**
   * Write a **sparse** patch into the live agent configuration.
   *
   * `PUT /api/config` deep-merges the body over what is on disk
   * (`hermes_cli/web_server.py::update_config` → `hermes_cli/config._deep_merge`):
   * maps recurse, so any key we do not send survives untouched — but every
   * other value, a **list included, is replaced outright**. That is why each
   * list this module writes is rebuilt from a config read taken moments before
   * the write, never from a cached copy.
   */
  patchConfig: (patch: Record<string, unknown>, profile?: string) =>
    requestJson(withProfile('/api/config', profile), {
      method: 'PUT',
      body: JSON.stringify({ config: patch, profile }),
    }),

  schema: async () => parseConfigSchema(await requestJson('/api/config/schema')),

  messagingPlatforms: async (profile?: string) =>
    parseMessagingPlatforms(await requestJson(withProfile('/api/messaging/platforms', profile))),

  terminalBackends: async (profile?: string) =>
    parseTerminalBackends(await requestJson(withProfile('/api/tools/terminal/backends', profile))),

  selectTerminalBackend: (backend: string, profile?: string) =>
    requestJson(withProfile('/api/tools/terminal/backend', profile), {
      method: 'PUT',
      body: JSON.stringify({ backend, profile }),
    }),

  computerUse: async (profile?: string) =>
    parseComputerUseStatus(
      await requestJson(withProfile('/api/tools/computer-use/status', profile)),
    ),

  grantComputerUse: (profile?: string) =>
    requestJson(withProfile('/api/tools/computer-use/permissions/grant', profile), {
      method: 'POST',
      body: JSON.stringify({ profile }),
    }),

  /** Values land in `~/.hermes/.env`; a blank value is a documented no-op. */
  saveToolsetEnv: (name: string, env: Record<string, string>, profile?: string) =>
    requestJson(withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}/env`, profile), {
      method: 'PUT',
      body: JSON.stringify({ env, profile }),
    }),

  runPostSetup: (name: string, key: string, profile?: string) =>
    requestJson(
      withProfile(`/api/tools/toolsets/${encodeURIComponent(name)}/post-setup`, profile),
      {
        method: 'POST',
        body: JSON.stringify({ key, profile }),
      },
    ),

  postSetupStatus: async () =>
    parseActionStatus(await requestJson('/api/actions/tools-post-setup/status')),
}
