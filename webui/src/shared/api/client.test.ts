import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  ApiPayloadError,
  expectArray,
  expectRecord,
  expectString,
  requestJson,
  withProfile,
} from './client'
import { RUNTIME_CLIENT_HEADER } from './runtime-client'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('requestJson', () => {
  it('adds JSON headers and same-origin credentials', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response('{"ok":true}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      requestJson('/api/example', { method: 'POST', body: JSON.stringify({ value: 1 }) }),
    ).resolves.toEqual({ ok: true })

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(init?.credentials).toBe('include')
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get(RUNTIME_CLIENT_HEADER)).toBeTruthy()
  })

  it('turns failed responses into typed API errors without losing the payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"detail":"denied"}', {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const promise = requestJson('/api/private')
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'denied',
      body: { detail: 'denied' },
    })
  })

  it('keeps malformed success bodies unknown until a boundary validator checks them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not-json', { status: 200 })),
    )
    const payload = await requestJson('/api/degraded')
    expect(payload).toBe('not-json')
    expect(() => expectRecord(payload, 'degraded response')).toThrow(ApiPayloadError)
  })

  it('aborts stalled requests after the configured timeout', async () => {
    vi.useFakeTimers()
    let rejectFetch: ((reason?: unknown) => void) | undefined
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const pending = requestJson('/api/hang', {}, { timeoutMs: 25 })
    const [, init] = fetchMock.mock.calls[0] ?? []
    await vi.advanceTimersByTimeAsync(25)
    expect(init?.signal?.aborted).toBe(true)
    rejectFetch?.(init?.signal?.reason)
    await expect(pending).rejects.toBeDefined()
  })
})

describe('API boundary helpers', () => {
  it('adds a profile exactly once and preserves an existing query', () => {
    expect(withProfile('/api/sessions?limit=40', 'research')).toBe(
      '/api/sessions?limit=40&profile=research',
    )
    expect(withProfile('/api/sessions?profile=existing', 'research')).toBe(
      '/api/sessions?profile=existing',
    )
    expect(withProfile('/api/sessions', 'default')).toBe('/api/sessions')
  })

  it('fails closed on unexpected primitives and collections', () => {
    expect(() => expectArray({}, 'rows')).toThrow('Invalid API payload: rows')
    expect(() => expectString(4, 'name')).toThrow('Invalid API payload: name')
    expect(expectRecord({ ok: true }, 'row')).toEqual({ ok: true })
  })
})
