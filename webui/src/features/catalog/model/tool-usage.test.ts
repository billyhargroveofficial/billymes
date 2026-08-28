import { describe, expect, it } from 'vitest'
import { filterToolRows, summariseToolRows, toolRows, usageCounts, usageIndex } from './tool-usage'

const USAGE = [
  { tool: 'terminal', count: 4631, percentage: 19.166459730154788 },
  { tool: 'web_extract', count: 2611, percentage: 10.806224650277295 },
  { tool: 'web_search', count: 300, percentage: 1.24 },
]

describe('per-tool usage', () => {
  it('indexes the analytics rows and exposes plain counts for the ranking helpers', () => {
    const index = usageIndex(USAGE)
    expect(index.get('terminal')).toEqual({ count: 4631, percentage: 19.166459730154788 })
    expect(usageCounts(index).get('web_extract')).toBe(2611)
  })

  it('lists a toolset busiest first and zero-fills tools that never ran', () => {
    const rows = toolRows(['web_search', 'web_extract', 'web_crawl'], usageIndex(USAGE))
    expect(rows.map((row) => row.tool)).toEqual(['web_extract', 'web_search', 'web_crawl'])
    expect(rows.at(-1)).toEqual({ tool: 'web_crawl', count: 0, percentage: 0 })
  })

  it('filters by substring and totals the набор share', () => {
    const rows = toolRows(['web_search', 'web_extract'], usageIndex(USAGE))
    expect(filterToolRows(rows, ' SEARCH ').map((row) => row.tool)).toEqual(['web_search'])
    expect(filterToolRows(rows, '')).toHaveLength(2)
    const summary = summariseToolRows(rows)
    expect(summary.tools).toBe(2)
    expect(summary.calls).toBe(2911)
    expect(summary.share).toBeCloseTo(12.046, 3)
  })
})
