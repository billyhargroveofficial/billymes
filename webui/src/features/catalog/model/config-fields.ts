import type { ConfigField, ToolPolicyConfig } from './types'

/**
 * The config paths the tools screen is allowed to edit. Anything outside these
 * prefixes belongs to another screen — the patch builder below can therefore
 * never reach a key this page does not render.
 */
const TOOL_SEARCH_PREFIX = 'tools.tool_search.'
const TOOL_OUTPUT_PREFIX = 'tool_output.'

/** Hand-written Russian labels; anything new falls back to the schema text. */
const LABELS: Record<string, string> = {
  'tools.tool_search.enabled': 'поиск по тулам',
  'tools.tool_search.threshold_pct': 'порог включения, %',
  'tools.tool_search.search_default_limit': 'результатов по умолчанию',
  'tools.tool_search.max_search_limit': 'максимум результатов',
  'tools.tool_search.listing': 'листинг тулов',
  'tools.tool_search.listing_max_tokens': 'бюджет листинга, токенов',
  'tool_output.max_bytes': 'вывод тула, байт',
  'tool_output.max_lines': 'вывод тула, строк',
  'tool_output.max_line_length': 'длина строки, символов',
}

type SettingsGroup = 'search' | 'output'

export type SettingsField = {
  path: string
  label: string
  /** the schema's declared type: number, string, boolean, select, list, … */
  type: string
  options: string[]
  group: SettingsGroup
  /** the value the gateway currently reports, as text for the input */
  value: string
}

function currentValue(path: string, config: ToolPolicyConfig): string {
  const [prefix, key] = path.startsWith(TOOL_SEARCH_PREFIX)
    ? (['search', path.slice(TOOL_SEARCH_PREFIX.length)] as const)
    : (['output', path.slice(TOOL_OUTPUT_PREFIX.length)] as const)
  const source = prefix === 'search' ? config.toolSearch : config.toolOutput
  const value = source[key]
  return value == null ? '' : String(value)
}

/**
 * Render the tool-runtime settings from `GET /api/config/schema` rather than a
 * hardcoded list: the schema is what the gateway will actually accept, so a
 * field Hermes drops or renames disappears here instead of silently failing.
 */
export function toolSettingsFields(
  schema: Record<string, ConfigField>,
  config: ToolPolicyConfig,
): SettingsField[] {
  return Object.values(schema)
    .filter(
      (field) =>
        field.path.startsWith(TOOL_SEARCH_PREFIX) || field.path.startsWith(TOOL_OUTPUT_PREFIX),
    )
    .map((field) => ({
      path: field.path,
      label: LABELS[field.path] ?? field.description ?? field.path,
      type: field.type,
      options: field.options,
      group: field.path.startsWith(TOOL_SEARCH_PREFIX) ? ('search' as const) : ('output' as const),
      value: currentValue(field.path, config),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function assign(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split('.')
  let node = target
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  node[segments.at(-1)!] = value
}

/**
 * Turn edited text inputs into the sparse nested body `PUT /api/config`
 * deep-merges. Untouched and unchanged fields are omitted entirely, and a
 * number field that does not parse is reported instead of being sent.
 */
export function buildToolSettingsPatch(
  fields: readonly SettingsField[],
  draft: Readonly<Record<string, string>>,
): { patch: Record<string, unknown> | null; invalid: string[] } {
  const patch: Record<string, unknown> = {}
  const invalid: string[] = []
  let changed = false

  for (const field of fields) {
    const raw = draft[field.path]
    if (raw === undefined || raw === field.value) continue
    if (field.type === 'number') {
      const parsed = Number(raw.trim())
      if (!raw.trim() || !Number.isFinite(parsed)) {
        invalid.push(field.label)
        continue
      }
      assign(patch, field.path, parsed)
    } else {
      assign(patch, field.path, raw.trim())
    }
    changed = true
  }

  return { patch: changed ? patch : null, invalid }
}
