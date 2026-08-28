import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CLIENT_HEADER } from '@/shared/api'
import {
  fetchGatewayRuntime,
  pushGatewaySettings,
  readGatewaySettings,
  writeGatewaySettings,
} from './gateway-settings'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.stubGlobal('sessionStorage', new MemoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gateway settings storage', () => {
  it('discards a legacy persistent token instead of rebinding it', () => {
    localStorage.setItem(
      'mes.gateway',
      JSON.stringify({
        mode: 'remote',
        origin: 'https://gateway.test',
        host: 'gateway.test',
        token: 'secret',
      }),
    )

    expect(readGatewaySettings()).toEqual({
      mode: 'remote',
      origin: 'https://gateway.test',
      host: 'gateway.test',
      token: '',
    })
    expect(sessionStorage.getItem('mes.gateway-token')).toBeNull()
    expect(localStorage.getItem('mes.gateway')).not.toContain('secret')
  })

  it('stores non-secret settings durably and the token only for the browser session', () => {
    writeGatewaySettings({
      mode: 'remote',
      origin: 'https://gateway.test',
      host: 'gateway.test',
      token: 'session-secret',
    })

    expect(JSON.parse(localStorage.getItem('mes.gateway') ?? '{}')).toEqual({
      mode: 'remote',
      origin: 'https://gateway.test',
      host: 'gateway.test',
    })
    expect(JSON.parse(sessionStorage.getItem('mes.gateway-token') ?? '{}')).toEqual({
      origin: 'https://gateway.test',
      host: 'gateway.test',
      token: 'session-secret',
    })
  })

  it('does not reuse a token stored for another gateway host', () => {
    writeGatewaySettings({
      mode: 'remote',
      origin: 'https://gateway.test',
      host: 'old-host.test',
      token: 'old-secret',
    })
    localStorage.setItem(
      'mes.gateway',
      JSON.stringify({ mode: 'remote', origin: 'https://gateway.test', host: 'new-host.test' }),
    )

    expect(readGatewaySettings().token).toBe('')
    expect(sessionStorage.getItem('mes.gateway-token')).toBeNull()
  })

  it('does not reuse a token stored for another gateway origin', () => {
    localStorage.setItem(
      'mes.gateway',
      JSON.stringify({ mode: 'remote', origin: 'https://new-gateway.test', host: '' }),
    )
    sessionStorage.setItem(
      'mes.gateway-token',
      JSON.stringify({ origin: 'https://old-gateway.test', token: 'old-secret' }),
    )

    expect(readGatewaySettings().token).toBe('')
    expect(sessionStorage.getItem('mes.gateway-token')).toBeNull()
  })
})

describe('gateway settings control request', () => {
  it('sends the selected runtime to the local control plane', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            origin: 'https://gateway.test',
            host: 'gateway.test',
            tokenSet: true,
            usingDefault: false,
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await pushGatewaySettings({
      mode: 'remote',
      origin: 'https://gateway.test/',
      host: '',
      token: 'session-secret',
    })

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/__mes/gateway')
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get(RUNTIME_CLIENT_HEADER)).toBeTruthy()
    expect(JSON.parse(String(init?.body))).toEqual({
      origin: 'https://gateway.test',
      host: 'gateway.test',
      token: 'session-secret',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('propagates caller cancellation to the control request', async () => {
    let rejectFetch: ((reason?: unknown) => void) | undefined
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = pushGatewaySettings(
      { mode: 'local', origin: '', host: '', token: '' },
      controller.signal,
    )

    const init = fetchMock.mock.calls[0]?.[1]
    controller.abort()
    expect(init?.signal?.aborted).toBe(true)
    rejectFetch?.(controller.signal.reason)
    await expect(pending).rejects.toBeDefined()
  })

  it('accepts a missing control endpoint for same-origin local production runtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    )

    await expect(
      pushGatewaySettings({ mode: 'local', origin: '', host: '', token: '' }),
    ).resolves.toBeNull()
  })

  it('accepts the production no-content control response without parsing JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )

    await expect(
      pushGatewaySettings({ mode: 'local', origin: '', host: '', token: '' }),
    ).resolves.toBeNull()
    await expect(fetchGatewayRuntime()).resolves.toBeNull()
  })
})
