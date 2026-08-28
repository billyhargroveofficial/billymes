import { describe, expect, it } from 'vitest'
import { modelCapabilityFor, modelList } from './model-list'

describe('modelList', () => {
  it('normalizes string and object model descriptors and ignores malformed rows', () => {
    expect(modelList(['plain', { id: 'object-model' }, null, { name: 'missing-id' }])).toEqual([
      'plain',
      'object-model',
    ])
    expect(modelList('not-an-array')).toEqual([])
  })

  it('uses the provider capability map and keeps unknown capabilities unavailable', () => {
    const providers = [
      {
        slug: 'fixture',
        name: 'Fixture',
        is_current: true,
        authenticated: true,
        models: ['reasoning-model', { id: 'legacy-model', supports_reasoning: true }],
        capabilities: {
          'reasoning-model': { fast: true, reasoning: true },
        },
      },
    ]

    expect(modelCapabilityFor(providers, 'fixture', 'reasoning-model')).toEqual({
      fast: true,
      reasoning: true,
    })
    expect(modelCapabilityFor(providers, 'fixture', 'legacy-model')).toEqual({
      fast: false,
      reasoning: true,
    })
    expect(modelCapabilityFor(providers, 'fixture', 'unknown-model')).toBeNull()
  })
})
