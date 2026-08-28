import type { ModelRow } from './types'

/**
 * `/api/analytics/models` reports one row per model *and* per accounting
 * bucket, so the same model/provider pair shows up several times. The table
 * needs one row per pair, which also gives us a stable React key.
 */
export function modelRowKey(row: Pick<ModelRow, 'model' | 'provider'>): string {
  return `${row.model} ${row.provider}`
}

export function mergeModelRows(rows: readonly ModelRow[]): ModelRow[] {
  const merged = new Map<string, ModelRow>()
  for (const row of rows) {
    const key = modelRowKey(row)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, { ...row, capabilities: { ...row.capabilities } })
      continue
    }
    current.inputTokens += row.inputTokens
    current.outputTokens += row.outputTokens
    current.cacheReadTokens += row.cacheReadTokens
    current.reasoningTokens += row.reasoningTokens
    current.estimatedCost += row.estimatedCost
    current.actualCost += row.actualCost
    current.sessions += row.sessions
    current.apiCalls += row.apiCalls
    current.toolCalls += row.toolCalls
    current.lastUsedAt = maxOrNull(current.lastUsedAt, row.lastUsedAt)
    if (current.capabilities.contextWindow == null && row.capabilities.contextWindow != null) {
      current.capabilities = { ...row.capabilities }
    }
  }
  return [...merged.values()].map((row) => ({
    ...row,
    avgTokensPerSession: row.sessions > 0 ? (row.inputTokens + row.outputTokens) / row.sessions : 0,
  }))
}

const MODEL_SORT_KEYS = [
  'model',
  'provider',
  'cost',
  'calls',
  'sessions',
  'input',
  'output',
  'toolCalls',
  'avg',
  'context',
  'lastUsed',
] as const

export type ModelSortKey = (typeof MODEL_SORT_KEYS)[number]
export type SortDirection = 'asc' | 'desc'

const NUMERIC: Record<Exclude<ModelSortKey, 'model' | 'provider'>, (row: ModelRow) => number> = {
  cost: (row) => row.estimatedCost,
  calls: (row) => row.apiCalls,
  sessions: (row) => row.sessions,
  input: (row) => row.inputTokens,
  output: (row) => row.outputTokens,
  toolCalls: (row) => row.toolCalls,
  avg: (row) => row.avgTokensPerSession,
  context: (row) => row.capabilities.contextWindow ?? 0,
  lastUsed: (row) => row.lastUsedAt ?? 0,
}

export function sortModelRows(
  rows: readonly ModelRow[],
  key: ModelSortKey,
  direction: SortDirection,
): ModelRow[] {
  const sign = direction === 'asc' ? 1 : -1
  const next = rows.slice()
  if (key === 'model' || key === 'provider') {
    next.sort((left, right) => sign * left[key].localeCompare(right[key], 'ru'))
    return next
  }
  const value = NUMERIC[key]
  next.sort(
    (left, right) =>
      sign * (value(left) - value(right)) || left.model.localeCompare(right.model, 'ru'),
  )
  return next
}

function maxOrNull(left: number | null, right: number | null): number | null {
  if (left == null) return right
  if (right == null) return left
  return Math.max(left, right)
}
