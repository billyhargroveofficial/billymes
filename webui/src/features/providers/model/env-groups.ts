import type { EnvVar } from './types'

export type EnvGroup = {
  category: string
  label: string
  vars: EnvVar[]
  /** Total in this category before the advanced filter hid anything. */
  total: number
  setCount: number
}

const CATEGORY_LABELS: Record<string, string> = {
  provider: 'провайдеры моделей',
  tool: 'тулы',
  skill: 'скиллы',
  custom: 'свои',
  messaging: 'каналы',
  setting: 'настройки',
}

const CATEGORY_ORDER = ['provider', 'tool', 'skill', 'custom', 'messaging', 'setting']

export function envCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category
}

function categoryRank(category: string): number {
  const index = CATEGORY_ORDER.indexOf(category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

function haystack(item: EnvVar): string {
  return [item.key, item.providerLabel, item.provider, item.description, ...item.tools]
    .join(' ')
    .toLowerCase()
}

export function matchesEnvQuery(item: EnvVar, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return needle.split(/\s+/).every((token) => haystack(item).includes(token))
}

/**
 * Groups env vars for the accordion. A key that is already set stays visible
 * even when advanced keys are hidden — an operator must never lose sight of a
 * credential the agent is actually using.
 */
export function groupEnvVars(
  vars: readonly EnvVar[],
  options: { query: string; showAdvanced: boolean },
): EnvGroup[] {
  const groups = new Map<string, EnvGroup>()
  for (const item of vars) {
    if (!matchesEnvQuery(item, options.query)) continue
    let group = groups.get(item.category)
    if (!group) {
      group = {
        category: item.category,
        label: envCategoryLabel(item.category),
        vars: [],
        total: 0,
        setCount: 0,
      }
      groups.set(item.category, group)
    }
    group.total += 1
    if (item.isSet) group.setCount += 1
    if (item.advanced && !options.showAdvanced && !item.isSet) continue
    group.vars.push(item)
  }
  return [...groups.values()]
    .filter((group) => group.vars.length > 0)
    .map((group) => ({ ...group, vars: [...group.vars].sort(compareEnvVars) }))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category))
}

/** Set keys first, then alphabetical — the useful rows stay at the top. */
export function compareEnvVars(a: EnvVar, b: EnvVar): number {
  if (a.isSet !== b.isSet) return a.isSet ? -1 : 1
  return a.key.localeCompare(b.key)
}

export function countSetEnvVars(vars: readonly EnvVar[]): number {
  return vars.reduce((total, item) => total + (item.isSet ? 1 : 0), 0)
}

export function hiddenAdvancedCount(
  vars: readonly EnvVar[],
  options: { query: string; showAdvanced: boolean },
): number {
  if (options.showAdvanced) return 0
  return vars.reduce(
    (total, item) =>
      total + (item.advanced && !item.isSet && matchesEnvQuery(item, options.query) ? 1 : 0),
    0,
  )
}
