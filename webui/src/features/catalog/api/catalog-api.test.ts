import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogApi, parseToolsetConfigPayload, parseToolsetModelsPayload } from './catalog-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toolset detail payloads', () => {
  it('keeps provider readiness and key state without retaining secret defaults', () => {
    const parsed = parseToolsetConfigPayload({
      name: 'web',
      has_category: true,
      active_provider: null,
      active_search_backend: 'codex-native',
      active_extract_backend: 'firecrawl',
      providers: [
        {
          name: 'Firecrawl',
          badge: 'paid',
          tag: 'search + extract',
          env_vars: [
            {
              key: 'FIRECRAWL_API_KEY',
              prompt: 'API key',
              url: 'https://example.test/keys',
              default: 'must-not-survive-the-parser',
              is_set: true,
            },
          ],
          post_setup: null,
          requires_nous_auth: false,
          is_active: false,
          status: 'ready',
          web_backend: 'firecrawl',
          capabilities: ['search', 'extract'],
        },
      ],
    })

    expect(parsed.activeSearchBackend).toBe('codex-native')
    expect(parsed.activeExtractBackend).toBe('firecrawl')
    expect(parsed.providers[0]).toMatchObject({
      name: 'Firecrawl',
      webBackend: 'firecrawl',
      capabilities: ['search', 'extract'],
      status: 'ready',
    })
    expect(parsed.providers[0]?.envVars[0]).toEqual({
      key: 'FIRECRAWL_API_KEY',
      prompt: 'API key',
      url: 'https://example.test/keys',
      isSet: true,
      hasDefault: true,
    })
    expect(JSON.stringify(parsed)).not.toContain('must-not-survive-the-parser')
  })

  it('parses a provider-specific model catalog', () => {
    const parsed = parseToolsetModelsPayload({
      name: 'image_gen',
      has_models: true,
      provider: 'FAL.ai',
      plugin: 'fal',
      current: 'fal-ai/flux-fast',
      default: 'fal-ai/flux-fast',
      models: [
        {
          id: 'fal-ai/flux-fast',
          display: 'FLUX Fast',
          speed: '<1s',
          strengths: 'Fast iteration',
          price: '$0.01',
        },
      ],
    })

    expect(parsed).toMatchObject({
      hasModels: true,
      provider: 'FAL.ai',
      plugin: 'fal',
      current: 'fal-ai/flux-fast',
    })
    expect(parsed.models).toHaveLength(1)
  })

  it('uses Hermes provider and model mutation contracts with profile scope', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await catalogApi.selectToolsetProvider('web', 'Codex Native Web Search', 'search', 'worker')
    await catalogApi.selectToolsetModel('image_gen', 'gpt-image-2-medium', 'OpenAI', 'worker')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/tools/toolsets/web/provider?profile=worker')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      provider: 'Codex Native Web Search',
      capability: 'search',
      profile: 'worker',
    })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/tools/toolsets/image_gen/model?profile=worker')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      model: 'gpt-image-2-medium',
      provider: 'OpenAI',
      profile: 'worker',
    })
  })
})
