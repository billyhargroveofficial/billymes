import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelSelectionApi } from './model-selection-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('modelSelectionApi capabilities', () => {
  it('parses live per-model capabilities and scopes options to a profile', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            providers: [
              {
                slug: 'openai-codex',
                name: 'Codex',
                is_current: true,
                authenticated: true,
                models: ['gpt-5.6-luna'],
                capabilities: {
                  'gpt-5.6-luna': {
                    fast: true,
                    reasoning: true,
                    can_disable_reasoning: true,
                  },
                },
              },
            ],
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(modelSelectionApi.options('research')).resolves.toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      providers: [
        {
          capabilities: {
            'gpt-5.6-luna': { fast: true, reasoning: true, can_disable_reasoning: true },
          },
        },
      ],
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/model/options?profile=research')
  })

  it('keeps detailed model-info capability metadata typed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'fixture-model',
              provider: 'fixture-provider',
              effective_context_length: 1000,
              capabilities: {
                supports_reasoning: false,
                supports_tools: true,
                context_window: 2000,
              },
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(modelSelectionApi.info('worker')).resolves.toEqual({
      model: 'fixture-model',
      provider: 'fixture-provider',
      effective_context_length: 1000,
      capabilities: {
        supports_reasoning: false,
        supports_tools: true,
        context_window: 2000,
      },
    })
  })

  it('rejects malformed capability rows instead of treating them as supported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              providers: [
                {
                  slug: 'fixture',
                  name: 'Fixture',
                  is_current: false,
                  authenticated: true,
                  models: ['fixture-model'],
                  capabilities: { 'fixture-model': { fast: 'yes', reasoning: true } },
                },
              ],
              provider: 'fixture',
              model: 'fixture-model',
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(modelSelectionApi.options()).rejects.toThrow(
      'Invalid API payload: model options.providers[0].capabilities.fixture-model.fast',
    )
  })
})
