import { describe, expect, it } from 'vitest'
import { mergeModelRows, modelRowKey, sortModelRows } from './model-rows'
import type { ModelRow } from './types'

function row(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    model: 'gpt-5.6-sol',
    provider: 'openai-codex',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 1000,
    reasoningTokens: 5,
    estimatedCost: 0.5,
    actualCost: 0,
    sessions: 2,
    apiCalls: 20,
    toolCalls: 4,
    lastUsedAt: 1_787_000_000,
    avgTokensPerSession: 55,
    capabilities: {
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: true,
      contextWindow: null,
      maxOutputTokens: null,
      family: '',
    },
    ...overrides,
  }
}

describe('modelRowKey', () => {
  it('keys on model and provider', () => {
    expect(modelRowKey({ model: 'a', provider: 'b' })).toBe('a b')
  })
})

describe('mergeModelRows', () => {
  it('collapses the repeated accounting rows the gateway sends', () => {
    const merged = mergeModelRows([row(), row({ apiCalls: 5, sessions: 3, estimatedCost: 0.25 })])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.apiCalls).toBe(25)
    expect(merged[0]?.sessions).toBe(5)
    expect(merged[0]?.estimatedCost).toBeCloseTo(0.75)
    expect(merged[0]?.inputTokens).toBe(200)
    expect(merged[0]?.toolCalls).toBe(8)
  })

  it('keeps different providers apart', () => {
    const merged = mergeModelRows([row(), row({ provider: 'xai-oauth' })])
    expect(merged).toHaveLength(2)
  })

  it('recomputes the average per session', () => {
    const merged = mergeModelRows([row({ sessions: 2, inputTokens: 90, outputTokens: 10 })])
    expect(merged[0]?.avgTokensPerSession).toBe(50)
  })

  it('reports zero average when nothing ran', () => {
    const merged = mergeModelRows([row({ sessions: 0 })])
    expect(merged[0]?.avgTokensPerSession).toBe(0)
  })

  it('keeps the newest last use and the richest capabilities', () => {
    const merged = mergeModelRows([
      row({ lastUsedAt: 1, capabilities: { ...row().capabilities, contextWindow: null } }),
      row({
        lastUsedAt: 500,
        capabilities: { ...row().capabilities, contextWindow: 272_000, family: 'gpt-sol' },
      }),
    ])
    expect(merged[0]?.lastUsedAt).toBe(500)
    expect(merged[0]?.capabilities.contextWindow).toBe(272_000)
    expect(merged[0]?.capabilities.family).toBe('gpt-sol')
  })

  it('does not mutate the source rows', () => {
    const source = row()
    mergeModelRows([source, row({ apiCalls: 7 })])
    expect(source.apiCalls).toBe(20)
  })
})

describe('sortModelRows', () => {
  const rows = [
    row({ model: 'b', estimatedCost: 0.1, apiCalls: 9 }),
    row({ model: 'a', estimatedCost: 0.9, apiCalls: 1 }),
  ]

  it('sorts numerically in both directions', () => {
    expect(sortModelRows(rows, 'cost', 'desc').map((entry) => entry.model)).toEqual(['a', 'b'])
    expect(sortModelRows(rows, 'cost', 'asc').map((entry) => entry.model)).toEqual(['b', 'a'])
    expect(sortModelRows(rows, 'calls', 'desc').map((entry) => entry.model)).toEqual(['b', 'a'])
  })

  it('sorts text columns alphabetically', () => {
    expect(sortModelRows(rows, 'model', 'asc').map((entry) => entry.model)).toEqual(['a', 'b'])
  })

  it('treats a missing context window as zero', () => {
    const sorted = sortModelRows(
      [
        row({ model: 'x' }),
        row({ model: 'y', capabilities: { ...row().capabilities, contextWindow: 10 } }),
      ],
      'context',
      'desc',
    )
    expect(sorted[0]?.model).toBe('y')
  })

  it('does not mutate the input', () => {
    sortModelRows(rows, 'cost', 'asc')
    expect(rows[0]?.model).toBe('b')
  })
})
