import { appendRuntimeClient } from '@/shared/api'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export type GatewayEvent = {
  type: string
  session_id?: string
  payload?: unknown
  profile?: string
  /** Monotonic within one gateway replay epoch. */
  seq?: number
  /** Advertised by gateway.ready; changes after a gateway restart. */
  replay_epoch?: string
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

type RpcDelivery = 'unsent' | 'uncertain'

/**
 * `uncertain` means `WebSocket.send()` returned, but the connection died before
 * the matching response arrived. Retrying a mutating RPC automatically can
 * duplicate the server-side operation.
 */
class GatewayRequestError extends Error {
  readonly delivery: RpcDelivery
  readonly method: string | undefined

  constructor(message: string, delivery: RpcDelivery, method?: string) {
    super(message)
    this.name = 'GatewayRequestError'
    this.delivery = delivery
    this.method = method
  }
}

export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000
export const GATEWAY_HEARTBEAT_ACK_TIMEOUT_MS = 45_000

type SocketFactory = (url: string) => WebSocket

type Handshake = {
  generation: number
  cancel: (error: Error) => void
}

export type GatewayClientOptions = {
  createSocket?: SocketFactory
  connectTimeoutMs?: number
  location?: () => Pick<Location, 'host' | 'protocol'>
}

export class GatewayClient {
  private socket: WebSocket | null = null
  private nextId = 0
  private pending = new Map<string, Pending>()
  private listeners = new Set<(event: GatewayEvent) => void>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private generation = 0
  private handshake: Handshake | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeat: { id: string; socket: WebSocket; generation: number; sentAt: number } | null =
    null
  private readonly createSocket: SocketFactory
  private readonly connectTimeoutMs: number
  private readonly getLocation: () => Pick<Location, 'host' | 'protocol'>
  state: ConnectionState = 'idle'

  constructor(options: GatewayClientOptions = {}) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.getLocation = options.location ?? (() => window.location)
  }

  onEvent(handler: (event: GatewayEvent) => void) {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  onState(handler: (state: ConnectionState) => void) {
    this.stateListeners.add(handler)
    handler(this.state)
    return () => {
      this.stateListeners.delete(handler)
    }
  }

  async connect(ticket: string) {
    const generation = ++this.generation
    this.cancelHandshake(new Error('WebSocket replaced'))
    this.stopHeartbeat()
    const previous = this.socket
    this.socket = null
    previous?.close()
    this.rejectAll(new GatewayRequestError('WebSocket replaced', 'uncertain'))
    this.setState('connecting')
    const currentLocation = this.getLocation()
    const proto = currentLocation.protocol === 'https:' ? 'wss' : 'ws'
    const url = appendRuntimeClient(
      `${proto}://${currentLocation.host}/api/ws?ticket=${encodeURIComponent(ticket)}`,
    )
    const socket = this.createSocket(url)
    this.socket = socket

    socket.addEventListener('message', (event) => {
      if (!this.isCurrent(socket, generation)) return
      const text = String(event.data)
      for (const line of text.split('\n')) {
        if (line.trim()) this.handle(line)
      }
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (this.handshake?.generation === generation) this.handshake = null
        callback()
      }
      this.handshake = {
        generation,
        cancel: (error) => settle(() => reject(error)),
      }
      timer = setTimeout(() => {
        if (!this.isCurrent(socket, generation)) return
        this.socket = null
        this.stopHeartbeat()
        this.setState('error')
        settle(() => reject(new Error('WebSocket timeout')))
        socket.close()
      }, this.connectTimeoutMs)
      socket.addEventListener('open', () => {
        if (!this.isCurrent(socket, generation)) return
        this.setState('open')
        settle(resolve)
      })
      socket.addEventListener('error', () => {
        if (!this.isCurrent(socket, generation)) return
        // A browser may emit `error` immediately before `close`.  Clear all
        // waiters while this socket is still current: once `this.socket` is
        // nulled the close listener intentionally ignores stale callbacks.
        // Delivery is uncertain because `send()` may already have handed the
        // frame to the browser, so mutating callers must recover via replay
        // instead of retrying automatically.
        this.rejectAll(new GatewayRequestError('WebSocket connection failed', 'uncertain'))
        this.socket = null
        this.stopHeartbeat()
        this.setState('error')
        settle(() => reject(new Error('WebSocket connection failed')))
        socket.close()
      })
      socket.addEventListener('close', () => {
        if (!this.isCurrent(socket, generation)) return
        this.socket = null
        this.stopHeartbeat()
        this.setState('closed')
        const error = new GatewayRequestError('WebSocket closed', 'uncertain')
        this.rejectAll(error)
        settle(() => reject(error))
      })
    })
  }

  close() {
    const error = new GatewayRequestError('WebSocket closed', 'uncertain')
    this.generation += 1
    this.cancelHandshake(error)
    const socket = this.socket
    this.socket = null
    this.stopHeartbeat()
    socket?.close()
    this.setState('closed')
    this.rejectAll(error)
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 120000) {
    const socket = this.socket
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new GatewayRequestError('gateway not connected', 'unsent', method))
    }
    const id = `w${++this.nextId}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A timeout happens after socket.send() completed. The gateway may
        // still execute a mutating RPC, so callers must not retry it blindly.
        reject(new GatewayRequestError(`request timed out: ${method}`, 'uncertain', method))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      })
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new GatewayRequestError(
            error instanceof Error ? error.message : 'WebSocket send failed',
            'unsent',
            method,
          ),
        )
      }
    })
  }

  private handle(raw: string) {
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch {
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const frame = value as {
      id?: string | number | null
      error?: unknown
      result?: unknown
      method?: string
      params?: unknown
    }
    if (frame.id !== undefined && frame.id !== null) {
      if (this.heartbeat?.id === String(frame.id)) {
        this.heartbeat = null
        return
      }
      const pending = this.pending.get(String(frame.id))
      if (!pending) return
      if (pending.timer) clearTimeout(pending.timer)
      this.pending.delete(String(frame.id))
      if (frame.error) {
        const message =
          typeof frame.error === 'object' &&
          frame.error !== null &&
          'message' in frame.error &&
          typeof frame.error.message === 'string'
            ? frame.error.message
            : 'Hermes RPC failed'
        pending.reject(new Error(message))
      } else pending.resolve(frame.result)
      return
    }
    if (
      frame.method === 'event' &&
      frame.params &&
      typeof frame.params === 'object' &&
      !Array.isArray(frame.params)
    ) {
      const params = frame.params as Record<string, unknown>
      if (typeof params.type !== 'string' || !params.type) return
      const event: GatewayEvent = {
        type: params.type,
        ...(typeof params.session_id === 'string' ? { session_id: params.session_id } : {}),
        ...(typeof params.profile === 'string' ? { profile: params.profile } : {}),
        ...('payload' in params ? { payload: params.payload } : {}),
        ...(typeof params.seq === 'number' && Number.isSafeInteger(params.seq)
          ? { seq: params.seq }
          : {}),
      }
      if (event.type === 'gateway.ready' && event.payload && typeof event.payload === 'object') {
        const ready = event.payload as Record<string, unknown>
        if (typeof ready.replay_epoch === 'string') event.replay_epoch = ready.replay_epoch
        if (ready.heartbeat === true && this.socket)
          this.startHeartbeat(this.socket, this.generation)
      }
      for (const listener of this.listeners) listener(event)
    }
  }

  private cancelHandshake(error: Error) {
    const handshake = this.handshake
    if (!handshake) return
    this.handshake = null
    handshake.cancel(error)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      // `close` is connection-wide, but delivery classification belongs to
      // each RPC. Preserve its method so prompt.submit can be treated as an
      // acknowledged-or-uncertain submit while session.create stays retryable.
      pending.reject(
        error instanceof GatewayRequestError
          ? new GatewayRequestError(error.message, error.delivery, pending.method)
          : error,
      )
    }
    this.pending.clear()
  }

  private startHeartbeat(socket: WebSocket, generation: number) {
    this.stopHeartbeat()
    const tick = () => {
      if (!this.isCurrent(socket, generation) || socket.readyState !== 1) return
      const pending = this.heartbeat
      if (pending) {
        if (Date.now() - pending.sentAt >= GATEWAY_HEARTBEAT_ACK_TIMEOUT_MS) socket.close()
        return
      }
      const id = `hb${++this.nextId}`
      this.heartbeat = { id, socket, generation, sentAt: Date.now() }
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'gateway.ping', params: {} }))
      } catch {
        this.heartbeat = null
        socket.close()
      }
    }
    this.heartbeatTimer = setInterval(tick, GATEWAY_HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeat = null
  }

  private setState(state: ConnectionState) {
    if (state === this.state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }

  private isCurrent(socket: WebSocket, generation: number) {
    return this.socket === socket && this.generation === generation
  }
}
