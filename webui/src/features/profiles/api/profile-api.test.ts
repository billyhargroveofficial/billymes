import { afterEach, describe, expect, it, vi } from 'vitest'
import { profileApi } from './profile-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('profileApi config', () => {
  it('parses profile-scoped model settings and normalizes disabled reasoning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: { default: 'fixture-model', provider: 'fixture-provider' },
              agent: { reasoning_effort: false, service_tier: 'fast' },
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(profileApi.config('worker')).resolves.toEqual({
      model: 'fixture-model',
      agent: { reasoning_effort: 'none', service_tier: 'fast' },
    })
  })

  it('updates only the requested agent setting through Hermes profile config PUT', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      profileApi.updateSettings('research', { service_tier: 'priority' }),
    ).resolves.toEqual({
      ok: true,
    })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/config?profile=research')
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(String(init?.body))).toEqual({
      config: { agent: { service_tier: 'priority' } },
    })
  })

  it('uses the default profile config endpoint without inventing a profile path', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await profileApi.updateSettings('default', { reasoning_effort: 'high' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/config')
  })
})
