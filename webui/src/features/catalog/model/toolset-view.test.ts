import { describe, expect, it } from 'vitest'
import {
  applyToolsetFacets,
  automationTools,
  DEFAULT_FACETS,
  facetsActive,
  filterToolsets,
  toolsetUsage,
} from './toolset-view'
import type { Toolset } from './types'

function toolset(overrides: Partial<Toolset>): Toolset {
  return {
    name: 'web',
    label: 'Web Search',
    description: 'search and extract',
    platform: 'cli',
    platform_label: 'CLI',
    enabled: true,
    available: true,
    configured: true,
    tools: ['web_search', 'web_extract'],
    ...overrides,
  }
}

describe('toolset presentation model', () => {
  it('aggregates usage and sorts matching toolsets by real tool counts', () => {
    const counts = new Map([
      ['web_search', 7],
      ['workflow', 12],
    ])
    const workflow = toolset({
      name: 'workflow',
      label: 'Workflow',
      description: 'multi-step jobs',
      tools: ['workflow', 'task_stop'],
    })
    const web = toolset({})

    expect(toolsetUsage(web, counts)).toBe(7)
    expect(filterToolsets([web, workflow], '', counts).map((row) => row.name)).toEqual([
      'workflow',
      'web',
    ])
    expect(filterToolsets([web, workflow], 'extract', counts)).toEqual([web])
  })

  it('derives automation only from tool names exposed by Hermes', () => {
    expect(
      automationTools(
        toolset({ tools: ['a2a_orchestrate', 'delegate_task', 'web_search', 'bus_status'] }),
      ),
    ).toEqual(['a2a_orchestrate', 'delegate_task', 'bus_status'])
  })
})

describe('toolset facets', () => {
  const web = toolset({})
  const off = toolset({ name: 'bfl', label: 'BFL', enabled: false, configured: true })
  const raw = toolset({ name: 'homeassistant', label: 'Home Assistant', configured: false })
  const all = [web, off, raw]

  it('keeps everything by default and reports itself as inactive', () => {
    expect(facetsActive(DEFAULT_FACETS)).toBe(false)
    expect(applyToolsetFacets(all, DEFAULT_FACETS, null)).toEqual(all)
  })

  it('narrows by state and by setup independently', () => {
    expect(
      applyToolsetFacets(all, { ...DEFAULT_FACETS, state: 'off' }, null).map((row) => row.name),
    ).toEqual(['bfl'])
    expect(
      applyToolsetFacets(all, { ...DEFAULT_FACETS, setup: 'pending' }, null).map((row) => row.name),
    ).toEqual(['homeassistant'])
  })

  it('filters by platform only when that platform has a list of its own', () => {
    const assigned = new Set(['web'])
    expect(
      applyToolsetFacets(all, { ...DEFAULT_FACETS, platform: 'cli' }, assigned).map(
        (row) => row.name,
      ),
    ).toEqual(['web'])
    expect(applyToolsetFacets(all, { ...DEFAULT_FACETS, platform: 'telegram' }, null)).toEqual(all)
  })
})
