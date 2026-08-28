import { describe, expect, it } from 'vitest'
import { buildToolSettingsPatch, toolSettingsFields } from './config-fields'
import type { ConfigField, ToolPolicyConfig } from './types'

const SCHEMA: Record<string, ConfigField> = {
  'tools.tool_search.enabled': {
    path: 'tools.tool_search.enabled',
    type: 'string',
    description: 'Tools → Tool Search → Enabled',
    options: [],
  },
  'tools.tool_search.threshold_pct': {
    path: 'tools.tool_search.threshold_pct',
    type: 'number',
    description: 'Tools → Tool Search → Threshold Pct',
    options: [],
  },
  'tool_output.max_bytes': {
    path: 'tool_output.max_bytes',
    type: 'number',
    description: 'Tool Output → Max Bytes',
    options: [],
  },
  'terminal.backend': {
    path: 'terminal.backend',
    type: 'select',
    description: 'Terminal execution backend',
    options: ['local', 'docker'],
  },
}

const CONFIG: ToolPolicyConfig = {
  platformToolsets: {},
  knownBuiltinToolsets: {},
  knownPluginToolsets: {},
  disabledToolsets: [],
  toolSearch: { enabled: 'auto', threshold_pct: 5 },
  toolOutput: { max_bytes: 50000 },
  terminalBackend: 'local',
}

describe('tool runtime settings fields', () => {
  it('renders only the paths this screen owns, with the gateway values', () => {
    const fields = toolSettingsFields(SCHEMA, CONFIG)
    expect(fields.map((field) => field.path)).toEqual([
      'tool_output.max_bytes',
      'tools.tool_search.enabled',
      'tools.tool_search.threshold_pct',
    ])
    expect(fields[0]).toMatchObject({ group: 'output', type: 'number', value: '50000' })
    expect(fields[1]).toMatchObject({ group: 'search', label: 'поиск по тулам', value: 'auto' })
  })

  it('falls back to the schema description for a field it has no label for', () => {
    const extra: ConfigField = {
      path: 'tools.tool_search.brand_new',
      type: 'string',
      description: 'Tools → Tool Search → Brand New',
      options: [],
    }
    const fields = toolSettingsFields({ ...SCHEMA, [extra.path]: extra }, CONFIG)
    expect(fields.find((field) => field.path === extra.path)).toMatchObject({
      label: 'Tools → Tool Search → Brand New',
      value: '',
    })
  })
})

describe('tool runtime settings patch', () => {
  const fields = toolSettingsFields(SCHEMA, CONFIG)

  it('nests dotted paths and omits everything untouched', () => {
    expect(buildToolSettingsPatch(fields, { 'tools.tool_search.threshold_pct': '9' })).toEqual({
      patch: { tools: { tool_search: { threshold_pct: 9 } } },
      invalid: [],
    })
    expect(buildToolSettingsPatch(fields, { 'tools.tool_search.threshold_pct': '5' })).toEqual({
      patch: null,
      invalid: [],
    })
    expect(buildToolSettingsPatch(fields, {})).toEqual({ patch: null, invalid: [] })
  })

  it('merges several branches into one body', () => {
    const { patch } = buildToolSettingsPatch(fields, {
      'tools.tool_search.enabled': 'always',
      'tools.tool_search.threshold_pct': '12',
      'tool_output.max_bytes': '80000',
    })
    expect(patch).toEqual({
      tools: { tool_search: { enabled: 'always', threshold_pct: 12 } },
      tool_output: { max_bytes: 80000 },
    })
  })

  it('reports a number field that does not parse instead of sending it', () => {
    const result = buildToolSettingsPatch(fields, {
      'tool_output.max_bytes': 'много',
      'tools.tool_search.enabled': 'off',
    })
    expect(result.invalid).toEqual(['вывод тула, байт'])
    expect(result.patch).toEqual({ tools: { tool_search: { enabled: 'off' } } })
  })
})
