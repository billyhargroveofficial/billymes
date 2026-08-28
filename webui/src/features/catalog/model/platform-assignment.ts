import type { MessagingPlatform, Toolset, ToolPolicyConfig } from './types'

/** The platform Hermes configures a toolset on unless the toolset is restricted. */
const CLI_PLATFORM = 'cli'

/**
 * Hermes resolves a toolset's configuration platform with
 * `_toolset_configuration_platform`: `cli` for everything unrestricted, and
 * the toolset's own supported platform when it is restricted away from `cli`
 * (today: the Discord toolsets). So a `platform` other than `cli` on the row
 * *is* the restriction, and we never have to mirror the upstream table.
 */
export function restrictedPlatform(toolset: Toolset): string | null {
  const platform = toolset.platform.trim()
  return platform && platform !== CLI_PLATFORM ? platform : null
}

/**
 * Every toolset key Hermes recognises as configurable. Anything else on a
 * `platform_toolsets` list is a composite default bundle (`hermes-cli`,
 * `hermes-discord`, …) or an MCP server name — entries the UI must preserve
 * verbatim and never claim as a toolset.
 */
export function knownToolsetKeys(
  config: ToolPolicyConfig,
  toolsets: readonly Toolset[],
): Set<string> {
  const keys = new Set<string>()
  for (const toolset of toolsets) keys.add(toolset.name)
  for (const list of Object.values(config.knownBuiltinToolsets))
    for (const key of list) keys.add(key)
  for (const list of Object.values(config.knownPluginToolsets))
    for (const key of list) keys.add(key)
  return keys
}

/** Toolset keys explicitly listed for a platform (composites excluded). */
export function assignedToolsets(
  config: ToolPolicyConfig,
  platform: string,
  known: ReadonlySet<string>,
): Set<string> {
  const entries = config.platformToolsets[platform] ?? []
  return new Set(entries.filter((entry) => known.has(entry)))
}

export type PlatformAssignment = {
  platform: string
  /** the platform carries its own `platform_toolsets` list on disk */
  explicit: boolean
  /** the toolset key is on that list */
  assigned: boolean
  /** unrecognised entries on the list: the platform's default bundle, MCP servers */
  extras: string[]
  /** null when the checkbox may be flipped, otherwise the reason it may not */
  locked: string | null
}

export function describeAssignment(
  config: ToolPolicyConfig,
  toolset: Toolset,
  platform: string,
  known: ReadonlySet<string>,
): PlatformAssignment {
  const entries = config.platformToolsets[platform]
  const explicit = Array.isArray(entries)
  const list = entries ?? []
  const restricted = restrictedPlatform(toolset)
  const locked = restricted
    ? restricted === platform
      ? null
      : `набор живёт только на площадке ${restricted}`
    : explicit
      ? null
      : 'у площадки нет своего списка — hermes отдаёт ей набор по умолчанию'
  return {
    platform,
    explicit,
    assigned: list.includes(toolset.name),
    extras: list.filter((entry) => !known.has(entry)),
    locked,
  }
}

/**
 * Build the sparse `PUT /api/config` body that adds or removes one toolset on
 * one platform. Returns `null` when the write would be unsafe or pointless:
 *
 * - a platform with no explicit list is served its default bundle, so writing
 *   a one-element list would silently narrow it from "everything" to "this";
 * - a toolset restricted to another platform is dropped by Hermes anyway
 *   (`_save_platform_tools` filters it), so the save would be a no-op the UI
 *   reported as success.
 *
 * The list is rebuilt from `config`, which the caller must have read from the
 * gateway immediately beforehand: `_deep_merge` replaces lists wholesale.
 */
export function buildPlatformAssignmentPatch(
  config: ToolPolicyConfig,
  toolset: Toolset,
  platform: string,
  assign: boolean,
  known: ReadonlySet<string>,
): Record<string, unknown> | null {
  const assignment = describeAssignment(config, toolset, platform, known)
  if (assignment.locked || assignment.assigned === assign) return null
  const current = config.platformToolsets[platform] ?? []
  const next = assign
    ? [...new Set([...current, toolset.name])].sort((left, right) => left.localeCompare(right))
    : current.filter((entry) => entry !== toolset.name)
  return { platform_toolsets: { [platform]: next } }
}

/**
 * Build the sparse patch that adds or removes a toolset from
 * `agent.disabled_toolsets` — the deny list Hermes subtracts after every
 * per-platform resolution, so nothing else can widen it back.
 */
export function buildDisabledToolsetsPatch(
  config: ToolPolicyConfig,
  toolset: string,
  denied: boolean,
): Record<string, unknown> | null {
  const current = config.disabledToolsets
  if (current.includes(toolset) === denied) return null
  const next = denied
    ? [...new Set([...current, toolset])].sort((left, right) => left.localeCompare(right))
    : current.filter((entry) => entry !== toolset)
  return { agent: { disabled_toolsets: next } }
}

export type PlatformOption = {
  id: string
  label: string
  /** the platform is in play: it is the CLI, has its own list, or is connected */
  primary: boolean
}

/**
 * The platforms worth showing, CLI first, then the ones that already carry a
 * toolset list, then the connected messaging platforms, then the rest.
 */
export function platformOptions(
  config: ToolPolicyConfig,
  platforms: readonly MessagingPlatform[],
): PlatformOption[] {
  const labels = new Map(platforms.map((platform) => [platform.id, platform.name || platform.id]))
  const connected = new Set(platforms.filter((platform) => platform.enabled).map((row) => row.id))
  const ids = new Set<string>([
    CLI_PLATFORM,
    ...Object.keys(config.platformToolsets),
    ...platforms.map((platform) => platform.id),
  ])
  const rank = (id: string) =>
    id === CLI_PLATFORM ? 0 : config.platformToolsets[id] ? 1 : connected.has(id) ? 2 : 3
  return [...ids]
    .map((id) => ({
      id,
      label: id === CLI_PLATFORM ? 'CLI / десктоп' : (labels.get(id) ?? id),
      primary: rank(id) < 3,
    }))
    .sort((left, right) => rank(left.id) - rank(right.id) || left.label.localeCompare(right.label))
}
