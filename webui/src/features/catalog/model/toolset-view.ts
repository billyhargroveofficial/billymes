import type { Toolset } from './types'

const AUTOMATION_TOOL = /(^|_)(cron|workflow|orchestrate|delegate|task|bus)(_|$)/iu

export function toolsetUsage(toolset: Toolset, counts: ReadonlyMap<string, number>) {
  return toolset.tools.reduce((total, tool) => total + (counts.get(tool) ?? 0), 0)
}

export function automationTools(toolset: Toolset) {
  return toolset.tools.filter((tool) => AUTOMATION_TOOL.test(tool))
}

export function filterToolsets(
  toolsets: Toolset[],
  query: string,
  counts: ReadonlyMap<string, number>,
) {
  const needle = query.trim().toLowerCase()
  return [...toolsets]
    .filter((toolset) => {
      if (!needle) return true
      return [
        toolset.name,
        toolset.label,
        toolset.description,
        toolset.platform,
        toolset.platform_label,
        ...toolset.tools,
      ].some((value) => value.toLowerCase().includes(needle))
    })
    .sort(
      (left, right) =>
        toolsetUsage(right, counts) - toolsetUsage(left, counts) ||
        left.label.localeCompare(right.label),
    )
}

export type ToolsetState = 'all' | 'on' | 'off'
export type ToolsetSetup = 'all' | 'ready' | 'pending'

export type ToolsetFacets = {
  /** platform the набор must be assigned to, or null for "любая" */
  platform: string | null
  state: ToolsetState
  setup: ToolsetSetup
}

export const DEFAULT_FACETS: ToolsetFacets = { platform: null, state: 'all', setup: 'all' }

export function facetsActive(facets: ToolsetFacets) {
  return facets.platform !== null || facets.state !== 'all' || facets.setup !== 'all'
}

/**
 * Narrow the catalog before the text search runs. `assigned` is the set of
 * toolset keys explicitly listed for the chosen platform; passing null (the
 * platform has no list of its own) keeps every row so the filter never lies
 * about a platform Hermes serves its default bundle to.
 */
export function applyToolsetFacets(
  toolsets: readonly Toolset[],
  facets: ToolsetFacets,
  assigned: ReadonlySet<string> | null,
): Toolset[] {
  return toolsets.filter((toolset) => {
    if (facets.state === 'on' && !toolset.enabled) return false
    if (facets.state === 'off' && toolset.enabled) return false
    if (facets.setup === 'ready' && !toolset.configured) return false
    if (facets.setup === 'pending' && toolset.configured) return false
    if (facets.platform && assigned && !assigned.has(toolset.name)) return false
    return true
  })
}
