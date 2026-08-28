import { describe, expect, it } from 'vitest'
import { poolEntryCount, poolProviderSuggestions, poolSourceLabel } from './pool-view'
import type { EnvVar, OauthProvider, PoolProvider } from './types'

const POOL: PoolProvider[] = [
  {
    provider: 'openai-codex',
    entries: [
      {
        index: 1,
        id: '42383e',
        label: 'personal-pro',
        authType: 'oauth',
        source: 'device_code',
        priority: 0,
        lastStatus: null,
        requestCount: 0,
        tokenPreview: 'eyJh...QWqg',
        hasRefresh: true,
      },
    ],
  },
]

describe('poolEntryCount', () => {
  it('sums entries across providers', () => {
    expect(poolEntryCount(POOL)).toBe(1)
    expect(poolEntryCount([])).toBe(0)
  })
})

describe('poolProviderSuggestions', () => {
  it('merges pool, oauth and env provider slugs without duplicates', () => {
    const oauth = [{ id: 'nous' }, { id: 'openai-codex' }] as OauthProvider[]
    const envVars = [{ provider: 'xai' }, { provider: '' }] as EnvVar[]
    expect(poolProviderSuggestions(POOL, oauth, envVars)).toEqual(['nous', 'openai-codex', 'xai'])
  })
})

describe('poolSourceLabel', () => {
  it('translates the known sources and passes others through', () => {
    expect(poolSourceLabel('manual')).toBe('добавлен вручную')
    expect(poolSourceLabel('device_code')).toBe('вход по коду')
    expect(poolSourceLabel('weird')).toBe('weird')
    expect(poolSourceLabel('')).toBe('источник неизвестен')
  })
})
