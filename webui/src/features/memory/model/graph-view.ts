import type { LearningCluster, LearningNode, MemoryChunk, MemoryEntry } from './types'

/** Russian noun forms for a count: [1, 2–4, 5+]. */
export type PluralForms = readonly [one: string, few: string, many: string]

export function plural(count: number, forms: PluralForms) {
  const absolute = Math.abs(Math.trunc(count))
  const mod100 = absolute % 100
  const mod10 = absolute % 10
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

export function formatCount(count: number, forms: PluralForms) {
  return `${Math.trunc(count)} ${plural(count, forms)}`
}

export const RECORD_FORMS: PluralForms = ['запись', 'записи', 'записей']
export const MEMORY_FORMS: PluralForms = ['воспоминание', 'воспоминания', 'воспоминаний']
export const SKILL_FORMS: PluralForms = ['скилл', 'скилла', 'скиллов']
export const LINK_FORMS: PluralForms = ['связь', 'связи', 'связей']
export const CATEGORY_FORMS: PluralForms = ['категория', 'категории', 'категорий']

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY
const YEAR = 365 * DAY

/** Unix seconds → laconic Russian relative age ("3 дня назад"). */
export function relativeTime(timestamp: number, nowMs: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'без даты'
  const seconds = Math.floor(nowMs / 1000) - Math.floor(timestamp)
  if (seconds < MINUTE) return 'только что'
  if (seconds < HOUR) return `${formatCount(seconds / MINUTE, ['минуту', 'минуты', 'минут'])} назад`
  if (seconds < DAY) return `${formatCount(seconds / HOUR, ['час', 'часа', 'часов'])} назад`
  if (seconds < MONTH) return `${formatCount(seconds / DAY, ['день', 'дня', 'дней'])} назад`
  if (seconds < YEAR) {
    return `${formatCount(seconds / MONTH, ['месяц', 'месяца', 'месяцев'])} назад`
  }
  return `${formatCount(seconds / YEAR, ['год', 'года', 'лет'])} назад`
}

const BYTE_UNITS = ['Б', 'КБ', 'МБ'] as const

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unit]}`
}

/**
 * The graph lists memory chunks twice: as `memory[]` (with bodies) and as
 * `nodes[]` (with the addressable ids the node endpoints take). They arrive in
 * the same order, so pair them positionally and fall back to the documented
 * `memory:<source>:<index>` shape if the gateway ever trims one side.
 */
export function buildMemoryEntries(
  memory: readonly MemoryChunk[],
  nodes: readonly LearningNode[],
): MemoryEntry[] {
  const ids = nodes.filter((node) => node.kind === 'memory').map((node) => node.id)
  return memory.map((chunk, index) => ({
    ...chunk,
    id: ids[index] ?? `memory:${chunk.source}:${index}`,
  }))
}

export function memorySourceCounts(entries: readonly MemoryEntry[]): LearningCluster[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
}

/**
 * The gateway derives a chunk's `title` by truncating its own body, so printing
 * both renders the same sentence twice. Only treat a title as a heading when it
 * says something the body's opening does not.
 */
export function titleAddsInformation(title: string, body: string) {
  const heading = title
    .replace(/[….\s]+$/u, '')
    .trim()
    .toLowerCase()
  if (!heading) return false
  const opening = body.trim().slice(0, heading.length).toLowerCase()
  return opening !== heading
}

function matches(needle: string, ...haystack: string[]) {
  if (!needle) return true
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

/** Newest first, filtered by free text across title/body and by chunk source. */
export function filterMemoryEntries(
  entries: readonly MemoryEntry[],
  query: string,
  source: string,
): MemoryEntry[] {
  const needle = query.trim().toLowerCase()
  return entries
    .filter((entry) => (source ? entry.source === source : true))
    .filter((entry) => matches(needle, entry.title, entry.body))
    .sort(
      (left, right) => right.timestamp - left.timestamp || left.title.localeCompare(right.title),
    )
}

/** Learned skills, most-used first, filtered by free text and category. */
export function filterSkillNodes(
  nodes: readonly LearningNode[],
  query: string,
  category: string,
): LearningNode[] {
  const needle = query.trim().toLowerCase()
  return nodes
    .filter((node) => node.kind === 'skill')
    .filter((node) => (category ? node.category === category : true))
    .filter((node) => matches(needle, node.label, node.category, node.createdBy ?? ''))
    .sort((left, right) => right.useCount - left.useCount || left.label.localeCompare(right.label))
}

export type ClusterBar = LearningCluster & { percent: number }

/** Category counts scaled against the largest cluster, for plain CSS bars. */
export function clusterBars(clusters: readonly LearningCluster[]): ClusterBar[] {
  const ranked = clusters
    .filter((cluster) => cluster.count > 0)
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
  const top = ranked[0]?.count ?? 0
  return ranked.map((cluster) => ({
    ...cluster,
    percent: top > 0 ? Math.max(4, Math.round((cluster.count / top) * 100)) : 0,
  }))
}
