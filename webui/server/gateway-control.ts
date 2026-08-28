import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ControlRequestError,
  normalizeHost,
  normalizeOrigin,
  normalizeToken,
  type GatewayRuntime,
  type RuntimeEntry,
  type RuntimeLease,
  type RuntimeMutation,
  type RuntimeRegistry,
} from './gateway-runtime.ts'

export const CONTROL_PATH = '/__mes/gateway'
export const MAX_CONTROL_BODY_BYTES = 1_000_000
const CONTROL_BODY_TIMEOUT_MS = 5_000

export function enqueueControl(
  registry: RuntimeRegistry,
  clientId: string,
  req: IncomingMessage,
  res: ServerResponse,
  defaults: GatewayRuntime,
  controlBody?: Record<string, unknown>,
  mutation?: RuntimeMutation,
) {
  let entry: RuntimeEntry
  let lease: RuntimeLease
  if (mutation) {
    entry = mutation.entry
    lease = mutation
    if (mutation.sequence !== entry.mutationSequence) {
      registry.releasePending(lease)
      sendSupersededError(res)
      return
    }
  } else {
    try {
      lease = registry.reserveControl(clientId)
      entry = lease.entry
    } catch (error) {
      sendControlError(res, error, req)
      return
    }
  }
  entry.controlQueue = entry.controlQueue
    .then(async () => {
      if (mutation && mutation.sequence !== entry.mutationSequence) {
        sendSupersededError(res)
        return
      }
      entry.runtime = await handleControl(req, res, entry.runtime, defaults, controlBody)
    })
    .catch(() => {
      sendJson(res, 500, { error: 'gateway control failed' })
    })
    .finally(() => {
      registry.releasePending(lease)
    })
}

async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: GatewayRuntime,
  defaults: GatewayRuntime,
  controlBody?: Record<string, unknown>,
): Promise<GatewayRuntime> {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (!isSameOriginBrowserRequest(req)) {
      throw new ControlRequestError(403, 'cross-origin gateway control is forbidden')
    }

    if (req.method === 'GET') {
      sendJson(res, 200, publicRuntime(runtime, defaults))
      return runtime
    }
    if (req.method === 'DELETE') {
      const next = { ...defaults }
      sendJson(res, 200, publicRuntime(next, defaults))
      return next
    }
    if (req.method !== 'PUT' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, PUT, POST, DELETE')
      throw new ControlRequestError(405, 'method not allowed')
    }

    const body = controlBody ?? {}
    const origin = normalizeOrigin(body.origin)
    const host = normalizeHost(body.host, origin)
    const originChanged = origin !== runtime.origin
    const hostChanged = host !== runtime.host
    const token = normalizeToken(
      body.token == null ? (originChanged || hostChanged ? '' : runtime.token) : body.token,
    )
    const next = { origin, host, token }
    sendJson(res, 200, publicRuntime(next, defaults))
    return next
  } catch (error) {
    const status = error instanceof ControlRequestError ? error.status : 400
    const message = error instanceof Error ? error.message : 'invalid gateway settings'
    sendJson(res, status, { error: message })
    return runtime
  }
}

function publicRuntime(runtime: GatewayRuntime, defaults: GatewayRuntime) {
  return {
    origin: runtime.origin,
    host: runtime.host,
    tokenSet: Boolean(runtime.token),
    usingDefault:
      runtime.origin === defaults.origin &&
      runtime.host === defaults.host &&
      runtime.token === defaults.token,
  }
}

export async function readControlBody(
  req: IncomingMessage,
  timeoutMs = CONTROL_BODY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const consume = (async () => {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_CONTROL_BODY_BYTES) {
          throw new ControlRequestError(413, 'gateway settings payload is too large')
        }
        chunks.push(buffer)
      }
    } catch (error) {
      if (error instanceof ControlRequestError) throw error
      throw new ControlRequestError(408, 'gateway settings payload was incomplete')
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('object required')
      }
      return value as Record<string, unknown>
    } catch {
      throw new ControlRequestError(400, 'gateway settings must be a JSON object')
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ControlRequestError(408, 'gateway settings payload timed out')),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([consume, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function normalizeControlBodyTimeout(value: number | undefined) {
  if (value === undefined) return CONTROL_BODY_TIMEOUT_MS
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('control body timeout must be a positive integer')
  }
  return value
}

export function rejectOversizedControlBody(req: IncomingMessage) {
  const contentLength = req.headers['content-length']
  if (Array.isArray(contentLength)) return
  if (!contentLength || !/^\d+$/u.test(contentLength)) return
  if (Number(contentLength) > MAX_CONTROL_BODY_BYTES) {
    throw new ControlRequestError(413, 'gateway settings payload is too large')
  }
}

export function rejectMissingRuntimeClient(res: ServerResponse, req: IncomingMessage) {
  req.resume()
  sendJson(res, 403, { error: 'runtime client id is required for gateway mutations' })
}

export function sendControlError(res: ServerResponse, error: unknown, req?: IncomingMessage) {
  const status = error instanceof ControlRequestError ? error.status : 400
  const message = error instanceof Error ? error.message : 'invalid gateway settings'
  if (req && req.method !== 'GET' && req.method !== 'HEAD') req.resume()
  if (req && (status === 408 || status === 413)) {
    res.shouldKeepAlive = false
    res.once('finish', () => {
      if (!req.socket.destroyed) req.socket.end()
    })
  }
  sendJson(res, status, { error: message })
}

export function isSameOriginBrowserRequest(req: IncomingMessage) {
  const fetchSite = req.headers['sec-fetch-site']
  if (Array.isArray(fetchSite)) return false
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return fetchSite === 'same-origin' || fetchSite === 'none'
  const host = req.headers.host
  if (!host || Array.isArray(origin)) return false
  try {
    const url = new URL(origin)
    const encrypted = 'encrypted' in req.socket && Boolean(req.socket.encrypted)
    const expected = new URL(`${encrypted ? 'https' : 'http'}://${host}`).origin
    return url.origin === expected
  } catch {
    return false
  }
}

function sendSupersededError(res: ServerResponse) {
  sendJson(res, 409, { error: 'gateway control was superseded by a newer mutation' })
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(JSON.stringify(body))
}
