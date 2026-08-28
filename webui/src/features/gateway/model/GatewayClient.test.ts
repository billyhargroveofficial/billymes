import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CLIENT_QUERY } from '@/shared/api'
import {
  GATEWAY_HEARTBEAT_ACK_TIMEOUT_MS,
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GatewayClient,
} from './GatewayClient'

type Listener = (event: { data?: unknown }) => void

class FakeSocket {
  readyState = 0
  sent: string[] = []
  url = ''
  private listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, event: { data?: unknown } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('socket closed')
    this.sent.push(data)
  }
}

function harness(connectTimeoutMs = 1_000) {
  const sockets: FakeSocket[] = []
  const client = new GatewayClient({
    connectTimeoutMs,
    createSocket: (url) => {
      const socket = new FakeSocket()
      socket.url = url
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
    location: () => ({ host: 'dashboard.test', protocol: 'https:' }),
  })
  return { client, sockets }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('GatewayClient', () => {
  it('connects with an encoded ticket and resolves JSON-RPC requests', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client, sockets } = harness()
    const connecting = client.connect('ticket with spaces')
    const socket = sockets[0]!
    socket.open()
    await connecting
    const socketUrl = new URL(socket.url)
    expect(socketUrl.searchParams.get('ticket')).toBe('ticket with spaces')
    expect(socketUrl.searchParams.get(RUNTIME_CLIENT_QUERY)).toBeTruthy()

    const response = client.request('example', { input: true })
    const frame = JSON.parse(socket.sent[0] ?? '{}') as { id: string }
    socket.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { value: 7 } }),
    })

    await expect(response).resolves.toEqual({ value: 7 })
    expect(client.state).toBe('open')
  })

  it('ignores close events from a replaced socket generation', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client, sockets } = harness()
    const first = client.connect('first')
    sockets[0]!.open()
    await first

    const second = client.connect('second')
    expect(client.state).toBe('connecting')
    sockets[0]!.emit('close')
    expect(client.state).toBe('connecting')
    sockets[1]!.open()
    await second
    expect(client.state).toBe('open')
  })

  it('rejects all pending requests when the current socket closes', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client, sockets } = harness()
    const connecting = client.connect('ticket')
    sockets[0]!.open()
    await connecting

    const pending = client.request('slow')
    sockets[0]!.close()
    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        'delivery' in error &&
        error.delivery === 'uncertain' &&
        'method' in error &&
        error.method === 'slow',
    )
    expect(client.state).toBe('closed')
  })

  it('rejects pending requests as uncertain when an open socket errors before close', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client, sockets } = harness()
    const connecting = client.connect('ticket')
    sockets[0]!.open()
    await connecting

    const pending = client.request('prompt.submit', { text: 'do not duplicate this' })
    sockets[0]!.emit('error')
    // Browsers normally emit close after error. The stale close callback must
    // not be the only path that releases this request.
    sockets[0]!.close()

    await expect(pending).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        'delivery' in error &&
        error.delivery === 'uncertain' &&
        'method' in error &&
        error.method === 'prompt.submit',
    )
    expect(client.state).toBe('error')
  })

  it('marks a timed-out RPC uncertain because send already completed', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    vi.useFakeTimers()
    const { client, sockets } = harness()
    const connecting = client.connect('ticket')
    sockets[0]!.open()
    await connecting

    const pending = expect(
      client.request('prompt.submit', { text: 'one turn only' }, 25),
    ).rejects.toMatchObject({
      delivery: 'uncertain',
      method: 'prompt.submit',
    })
    await vi.advanceTimersByTimeAsync(25)
    await pending
  })

  it('settles an in-flight handshake when the client is closed or replaced', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client } = harness()
    const closedHandshake = expect(client.connect('first')).rejects.toThrow('WebSocket closed')
    client.close()
    await closedHandshake

    const replacedHandshake = expect(client.connect('second')).rejects.toThrow('WebSocket replaced')
    const currentHandshake = client.connect('third')
    await replacedHandshake
    client.close()
    await expect(currentHandshake).rejects.toThrow('WebSocket closed')
  })

  it('ignores malformed primitive frames without throwing', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    const { client, sockets } = harness()
    const connecting = client.connect('ticket')
    sockets[0]!.open()
    await connecting
    expect(() => sockets[0]!.emit('message', { data: 'null' })).not.toThrow()
    expect(client.state).toBe('open')
  })

  it('fails a stalled handshake deterministically', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    vi.useFakeTimers()
    const { client } = harness(25)
    const rejection = expect(client.connect('ticket')).rejects.toThrow('WebSocket timeout')
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(client.state).toBe('error')
  })

  it('keeps replay metadata and capability-gates heartbeat pings', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    vi.useFakeTimers()
    const { client, sockets } = harness()
    const events: unknown[] = []
    client.onEvent((event) => events.push(event))
    const connecting = client.connect('ticket')
    sockets[0]!.open()
    await connecting
    sockets[0]!.emit('message', {
      data: JSON.stringify({
        method: 'event',
        params: { type: 'gateway.ready', payload: { heartbeat: true, replay_epoch: 'epoch-a' } },
      }),
    })
    sockets[0]!.emit('message', {
      data: JSON.stringify({
        method: 'event',
        params: { type: 'message.delta', session_id: 's', seq: 7 },
      }),
    })
    expect(events).toEqual([
      expect.objectContaining({ type: 'gateway.ready', replay_epoch: 'epoch-a' }),
      expect.objectContaining({ type: 'message.delta', seq: 7 }),
    ])
    await vi.advanceTimersByTimeAsync(GATEWAY_HEARTBEAT_INTERVAL_MS)
    const ping = JSON.parse(sockets[0]!.sent[0] ?? '{}') as { id: string; method: string }
    expect(ping.method).toBe('gateway.ping')
    sockets[0]!.emit('message', { data: JSON.stringify({ id: ping.id, result: { ok: true } }) })
    await vi.advanceTimersByTimeAsync(GATEWAY_HEARTBEAT_INTERVAL_MS)
    expect(sockets[0]!.readyState).toBe(WebSocket.OPEN)
  })

  it('closes an unacknowledged heartbeat and clears it when replacing sockets', async () => {
    vi.stubGlobal('WebSocket', { OPEN: 1, CLOSED: 3 })
    vi.useFakeTimers()
    const { client, sockets } = harness()
    const first = client.connect('first')
    sockets[0]!.open()
    await first
    sockets[0]!.emit('message', {
      data: JSON.stringify({
        method: 'event',
        params: { type: 'gateway.ready', payload: { heartbeat: true } },
      }),
    })
    await vi.advanceTimersByTimeAsync(GATEWAY_HEARTBEAT_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(GATEWAY_HEARTBEAT_ACK_TIMEOUT_MS)
    expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED)

    const second = client.connect('second')
    sockets[1]!.open()
    await second
    await vi.advanceTimersByTimeAsync(GATEWAY_HEARTBEAT_ACK_TIMEOUT_MS)
    expect(sockets[1]!.sent).toEqual([])
  })
})
