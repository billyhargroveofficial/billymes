import net from 'node:net'
import type { IncomingMessage } from 'node:http'
import {
  isRuntimeClientId,
  RUNTIME_CLIENT_HEADER,
  RUNTIME_CLIENT_QUERY,
} from '../src/shared/api/runtime-client.ts'

export type GatewayRuntime = {
  origin: string
  host: string
  token: string
}

export class ControlRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type RuntimeEntry = {
  runtime: GatewayRuntime
  controlQueue: Promise<void>
  pendingControls: number
  activeWebSockets: number
  mutationSequence: number
  lastUsedAt: number
}

export type RuntimeLease = {
  entry: RuntimeEntry
  released: boolean
}

export type RuntimeMutation = RuntimeLease & {
  sequence: number
}

export type RuntimeRegistry = {
  get: (clientId: string) => RuntimeEntry
  reserveControl: (clientId: string) => RuntimeLease
  reserveMutation: (clientId: string) => RuntimeMutation
  reserveWebSocket: (clientId: string) => RuntimeLease
  releasePending: (lease: RuntimeLease) => void
  releaseWebSocket: (lease: RuntimeLease) => void
  cleanup: () => void
}

const RUNTIME_CLIENT_TTL_MS = 30 * 60_000
const MAX_RUNTIME_CLIENTS = 256

export function createRuntimeRegistry(
  defaults: GatewayRuntime,
  ttlMs: number,
  maxClients: number,
): RuntimeRegistry {
  const entries = new Map<string, RuntimeEntry>()

  const cleanup = () => {
    const now = Date.now()
    for (const [clientId, entry] of entries) {
      if (
        entry.pendingControls === 0 &&
        entry.activeWebSockets === 0 &&
        now - entry.lastUsedAt >= ttlMs
      ) {
        entries.delete(clientId)
      }
    }
  }

  const get = (clientId: string) => {
    cleanup()
    const existing = entries.get(clientId)
    if (existing) {
      existing.lastUsedAt = Date.now()
      // Reinsert to make the oldest entry the first eviction candidate.
      entries.delete(clientId)
      entries.set(clientId, existing)
      return existing
    }
    while (entries.size >= maxClients) {
      let evicted = false
      for (const [oldest, oldestEntry] of entries) {
        if (oldestEntry.pendingControls > 0 || oldestEntry.activeWebSockets > 0) continue
        entries.delete(oldest)
        evicted = true
        break
      }
      if (!evicted) {
        throw new ControlRequestError(503, 'gateway runtime registry is busy')
      }
    }
    const entry: RuntimeEntry = {
      runtime: { ...defaults },
      controlQueue: Promise.resolve(),
      pendingControls: 0,
      activeWebSockets: 0,
      mutationSequence: 0,
      lastUsedAt: Date.now(),
    }
    entries.set(clientId, entry)
    return entry
  }

  const reserveControl = (clientId: string): RuntimeLease => {
    const entry = get(clientId)
    entry.pendingControls += 1
    return { entry, released: false }
  }

  const reserveMutation = (clientId: string): RuntimeMutation => {
    const lease = reserveControl(clientId)
    const { entry } = lease
    entry.mutationSequence += 1
    return { ...lease, sequence: entry.mutationSequence }
  }

  const reserveWebSocket = (clientId: string): RuntimeLease => {
    const entry = get(clientId)
    entry.activeWebSockets += 1
    return { entry, released: false }
  }

  const releasePending = (lease: RuntimeLease) => {
    if (lease.released) return
    lease.released = true
    const { entry } = lease
    entry.pendingControls -= 1
    entry.lastUsedAt = Date.now()
    cleanup()
  }

  const releaseWebSocket = (lease: RuntimeLease) => {
    if (lease.released) return
    lease.released = true
    const { entry } = lease
    entry.activeWebSockets -= 1
    entry.lastUsedAt = Date.now()
    cleanup()
  }

  return {
    get,
    reserveControl,
    reserveMutation,
    reserveWebSocket,
    releasePending,
    releaseWebSocket,
    cleanup,
  }
}

export function normalizeRuntimeClientTtl(value: number | undefined) {
  if (value === undefined) return RUNTIME_CLIENT_TTL_MS
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('runtime client TTL must be a positive integer')
  }
  return value
}

export function normalizeMaxRuntimeClients(value: number | undefined) {
  if (value === undefined) return MAX_RUNTIME_CLIENTS
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('max runtime clients must be a positive integer')
  }
  return value
}

export function runtimeClientIdFromHeader(req: IncomingMessage) {
  const raw = req.headers[RUNTIME_CLIENT_HEADER.toLowerCase()]
  if (raw === undefined) return undefined
  if (Array.isArray(raw) || !isRuntimeClientId(raw)) {
    throw new ControlRequestError(400, 'invalid runtime client id')
  }
  return raw
}

export function runtimeClientIdFromQuery(url: string | undefined) {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url, 'http://mes.invalid')
  } catch {
    throw new ControlRequestError(400, 'invalid runtime client id')
  }
  const values = parsed.searchParams.getAll(RUNTIME_CLIENT_QUERY)
  if (values.length === 0) return undefined
  if (values.length !== 1 || !isRuntimeClientId(values[0])) {
    throw new ControlRequestError(400, 'invalid runtime client id')
  }
  return values[0]
}

export function normalizeRuntime(runtime: GatewayRuntime): GatewayRuntime {
  const origin = normalizeOrigin(runtime.origin)
  return {
    origin,
    host: normalizeHost(runtime.host, origin),
    token: normalizeToken(runtime.token),
  }
}

export function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ControlRequestError(400, 'origin required')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ControlRequestError(400, 'origin must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ControlRequestError(400, 'origin must use http or https')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ControlRequestError(400, 'origin must not contain credentials, path, query, or hash')
  }
  return url.origin
}

export function normalizeHost(value: unknown, origin: string): string {
  const fallback = new URL(origin).host
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (candidate.length > 255 || /[\r\n/@?#\\]/u.test(candidate)) {
    throw new ControlRequestError(400, 'invalid gateway host')
  }
  let parsed: URL
  try {
    parsed = new URL(`http://${candidate}`)
  } catch {
    throw new ControlRequestError(400, 'invalid gateway host')
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ControlRequestError(400, 'invalid gateway host')
  }
  return parsed.host
}

export function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ControlRequestError(400, 'gateway token must be a string')
  }
  if (value.length > 16_384 || /[^\x21-\x7e]/u.test(value)) {
    throw new ControlRequestError(400, 'gateway token contains invalid characters')
  }
  return value
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  if (normalized === '::1') return true
  if (net.isIP(normalized) !== 4) return false
  return normalized.split('.')[0] === '127'
}
