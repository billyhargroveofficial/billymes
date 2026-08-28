import { describe, expect, it } from 'vitest'
import {
  compareEnvVars,
  countSetEnvVars,
  envCategoryLabel,
  groupEnvVars,
  hiddenAdvancedCount,
  matchesEnvQuery,
} from './env-groups'
import type { EnvVar } from './types'

function envVar(overrides: Partial<EnvVar> & { key: string }): EnvVar {
  return {
    isSet: false,
    redactedValue: null,
    description: '',
    url: null,
    category: 'provider',
    isPassword: true,
    tools: [],
    advanced: false,
    channelManaged: false,
    provider: '',
    providerLabel: '',
    custom: false,
    ...overrides,
  }
}

const VARS: EnvVar[] = [
  envVar({
    key: 'XAI_API_KEY',
    category: 'provider',
    advanced: true,
    providerLabel: 'xAI',
    provider: 'xai',
  }),
  envVar({
    key: 'ANTHROPIC_API_KEY',
    category: 'provider',
    isSet: true,
    providerLabel: 'Anthropic',
  }),
  envVar({ key: 'FIRECRAWL_API_KEY', category: 'tool', isSet: true, tools: ['web_search'] }),
  envVar({ key: 'TAVILY_API_KEY', category: 'tool', description: 'Tavily search key' }),
  envVar({ key: 'TELEGRAM_BOT_TOKEN', category: 'messaging', isSet: true, channelManaged: true }),
  envVar({ key: 'SOME_ADVANCED', category: 'tool', advanced: true }),
]

describe('matchesEnvQuery', () => {
  it('matches an empty query', () => {
    expect(matchesEnvQuery(VARS[0] as EnvVar, '   ')).toBe(true)
  })

  it('matches on key, provider label, description and tool name', () => {
    expect(matchesEnvQuery(VARS[0] as EnvVar, 'xai')).toBe(true)
    expect(matchesEnvQuery(VARS[1] as EnvVar, 'anthropic')).toBe(true)
    expect(matchesEnvQuery(VARS[2] as EnvVar, 'web_search')).toBe(true)
    expect(matchesEnvQuery(VARS[3] as EnvVar, 'tavily search')).toBe(true)
  })

  it('requires every token to match', () => {
    expect(matchesEnvQuery(VARS[3] as EnvVar, 'tavily firecrawl')).toBe(false)
  })
})

describe('groupEnvVars', () => {
  it('orders categories deterministically and labels them in Russian', () => {
    const groups = groupEnvVars(VARS, { query: '', showAdvanced: true })
    expect(groups.map((group) => group.category)).toEqual(['provider', 'tool', 'messaging'])
    expect(groups.map((group) => group.label)).toEqual(['провайдеры моделей', 'тулы', 'каналы'])
  })

  it('hides advanced keys that are not set but keeps advanced keys that are', () => {
    const groups = groupEnvVars(
      [...VARS, envVar({ key: 'ADVANCED_BUT_SET', category: 'tool', advanced: true, isSet: true })],
      { query: '', showAdvanced: false },
    )
    const tools = groups.find((group) => group.category === 'tool')
    expect(tools?.vars.map((item) => item.key)).toEqual([
      'ADVANCED_BUT_SET',
      'FIRECRAWL_API_KEY',
      'TAVILY_API_KEY',
    ])
  })

  it('keeps the totals honest even when the advanced filter hides rows', () => {
    const groups = groupEnvVars(VARS, { query: '', showAdvanced: false })
    const tools = groups.find((group) => group.category === 'tool')
    expect(tools?.total).toBe(3)
    expect(tools?.setCount).toBe(1)
    expect(tools?.vars).toHaveLength(2)
  })

  it('drops groups with nothing left to show', () => {
    const groups = groupEnvVars(VARS, { query: 'firecrawl', showAdvanced: true })
    expect(groups.map((group) => group.category)).toEqual(['tool'])
    expect(groups[0]?.vars.map((item) => item.key)).toEqual(['FIRECRAWL_API_KEY'])
  })

  it('sorts set keys first, then alphabetically', () => {
    const groups = groupEnvVars(VARS, { query: '', showAdvanced: true })
    expect(groups[0]?.vars.map((item) => item.key)).toEqual(['ANTHROPIC_API_KEY', 'XAI_API_KEY'])
  })

  it('does not mutate the input order', () => {
    const input = [...VARS]
    groupEnvVars(input, { query: '', showAdvanced: true })
    expect(input.map((item) => item.key)).toEqual(VARS.map((item) => item.key))
  })
})

describe('hiddenAdvancedCount', () => {
  it('counts only unset advanced keys that survive the query', () => {
    expect(hiddenAdvancedCount(VARS, { query: '', showAdvanced: false })).toBe(2)
    expect(hiddenAdvancedCount(VARS, { query: 'xai', showAdvanced: false })).toBe(1)
  })

  it('is zero when advanced keys are shown', () => {
    expect(hiddenAdvancedCount(VARS, { query: '', showAdvanced: true })).toBe(0)
  })
})

describe('countSetEnvVars, compareEnvVars and envCategoryLabel', () => {
  it('counts the keys that are actually set', () => {
    expect(countSetEnvVars(VARS)).toBe(3)
  })

  it('puts a set key ahead of an unset one', () => {
    expect(compareEnvVars(VARS[1] as EnvVar, VARS[0] as EnvVar)).toBeLessThan(0)
  })

  it('falls back to the raw category name', () => {
    expect(envCategoryLabel('skill')).toBe('скиллы')
    expect(envCategoryLabel('other')).toBe('other')
  })
})
