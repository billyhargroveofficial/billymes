import type { ToolUsage } from './types'

type ToolRow = {
  tool: string
  count: number
  /** share of every tool call in the analytics window, as reported by Hermes */
  percentage: number
}

/** Index `GET /api/analytics/usage` → `tools` by tool name. */
export function usageIndex(rows: readonly ToolRow[]): Map<string, ToolUsage> {
  const index = new Map<string, ToolUsage>()
  for (const row of rows) index.set(row.tool, { count: row.count, percentage: row.percentage })
  return index
}

/** Call counts only — the shape the toolset ranking helpers take. */
export function usageCounts(index: ReadonlyMap<string, ToolUsage>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const [tool, usage] of index) counts.set(tool, usage.count)
  return counts
}

/**
 * The individual tools a toolset publishes, busiest first. Hermes has no
 * per-tool switch — this list exists so the набор-level toggle is legible.
 */
export function toolRows(
  tools: readonly string[],
  index: ReadonlyMap<string, ToolUsage>,
): ToolRow[] {
  return tools
    .map((tool) => ({
      tool,
      count: index.get(tool)?.count ?? 0,
      percentage: index.get(tool)?.percentage ?? 0,
    }))
    .sort((left, right) => right.count - left.count || left.tool.localeCompare(right.tool))
}

export function filterToolRows(rows: readonly ToolRow[], query: string): ToolRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter((row) => row.tool.toLowerCase().includes(needle))
}

export function summariseToolRows(rows: readonly ToolRow[]) {
  return rows.reduce(
    (total, row) => ({
      tools: total.tools + 1,
      calls: total.calls + row.count,
      share: total.share + row.percentage,
    }),
    { tools: 0, calls: 0, share: 0 },
  )
}
