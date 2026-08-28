import http from 'node:http'
import type { Duplex } from 'node:stream'
import type { Connect, Plugin } from 'vite'
import {
  CONTROL_PATH,
  enqueueControl,
  normalizeControlBodyTimeout,
  readControlBody,
  rejectMissingRuntimeClient,
  rejectOversizedControlBody,
  sendControlError,
  sendJson,
  isSameOriginBrowserRequest,
} from './gateway-control.ts'
import {
  forwardHttp,
  forwardWs,
  isApiPath,
  isReadOnlyHttpMethod,
  isWebSocketUpgrade,
  isWsPath,
  requestPath,
  writeSocketError,
} from './gateway-forwarding.ts'
import {
  ControlRequestError,
  createRuntimeRegistry,
  isLoopbackAddress,
  normalizeRuntime,
  normalizeMaxRuntimeClients,
  normalizeRuntimeClientTtl,
  runtimeClientIdFromHeader,
  runtimeClientIdFromQuery,
  type GatewayRuntime,
} from './gateway-runtime.ts'

export { MAX_CONTROL_BODY_BYTES } from './gateway-control.ts'
export {
  isLoopbackAddress,
  normalizeHost,
  normalizeOrigin,
  normalizeRuntime,
  normalizeToken,
} from './gateway-runtime.ts'

type GatewayProxyOptions = {
  defaults: GatewayRuntime
  controlBodyTimeoutMs?: number
  runtimeClientTtlMs?: number
  maxRuntimeClients?: number
}

type GatewayProxy = {
  handle: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean
  attach: (httpServer: { once: (event: 'close', listener: () => void) => unknown } | null) => void
  close: () => void
}

type UpgradeCapableServer = {
  once: (event: 'close', listener: () => void) => unknown
  on: (
    event: 'upgrade',
    listener: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void,
  ) => unknown
}

/** Shared gateway boundary for Vite and the generic production server. */
function createGatewayProxy(options: GatewayProxyOptions): GatewayProxy {
  const defaults = normalizeRuntime(options.defaults)
  const controlBodyTimeoutMs = normalizeControlBodyTimeout(options.controlBodyTimeoutMs)
  const runtimeClientTtlMs = normalizeRuntimeClientTtl(options.runtimeClientTtlMs)
  const maxRuntimeClients = normalizeMaxRuntimeClients(options.maxRuntimeClients)
  const registry = createRuntimeRegistry(defaults, runtimeClientTtlMs, maxRuntimeClients)
  let cleanupTimer: ReturnType<typeof setInterval> | undefined

  const close = () => {
    if (cleanupTimer) clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }

  const attach = (
    httpServer: { once: (event: 'close', listener: () => void) => unknown } | null,
  ) => {
    if (!httpServer || cleanupTimer) return
    cleanupTimer = setInterval(registry.cleanup, Math.min(runtimeClientTtlMs, 60_000))
    cleanupTimer.unref()
    httpServer.once('close', close)
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
    const path = requestPath(req.url)
    if (path === CONTROL_PATH) {
      handleControlRoute(req, res)
      return
    }
    if (!isApiPath(path)) {
      next()
      return
    }
    if (!allowRequest(req) || !isSameOriginBrowserRequest(req)) {
      sendJson(res, 403, { error: 'gateway proxy is bound to this host' })
      return
    }
    let clientId: string | undefined
    try {
      clientId = runtimeClientIdFromHeader(req)
    } catch (error) {
      sendControlError(res, error, req)
      return
    }
    if (!clientId && !isReadOnlyHttpMethod(req.method)) {
      rejectMissingRuntimeClient(res, req)
      return
    }
    let runtime = defaults
    if (clientId) {
      try {
        runtime = registry.get(clientId).runtime
      } catch (error) {
        sendControlError(res, error, req)
        return
      }
    }
    forwardHttp(req, res, runtime)
  }

  const handleUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = requestPath(req.url)
    if (!isWsPath(path)) return false
    if (!isWebSocketUpgrade(req)) {
      writeSocketError(socket, 400, 'Bad Request')
      return true
    }
    if (!allowRequest(req) || !isSameOriginBrowserRequest(req)) {
      writeSocketError(socket, 403, 'Forbidden')
      return true
    }
    let clientId: string | undefined
    try {
      clientId = runtimeClientIdFromQuery(req.url)
    } catch {
      writeSocketError(socket, 400, 'Bad Request')
      return true
    }
    if (!clientId) {
      writeSocketError(socket, 403, 'Forbidden')
      return true
    }
    try {
      const lease = registry.reserveWebSocket(clientId)
      forwardWs(req, socket, head, lease.entry.runtime, () => registry.releaseWebSocket(lease))
    } catch (error) {
      const status = error instanceof ControlRequestError ? error.status : 503
      writeSocketError(socket, status, statusText(status))
    }
    return true
  }

  function handleControlRoute(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!allowRequest(req)) {
      sendJson(res, 403, { error: 'gateway control is available only from this host' })
      return
    }
    if (!isSameOriginBrowserRequest(req)) {
      sendJson(res, 403, { error: 'cross-origin gateway control is forbidden' })
      return
    }
    let clientId: string | undefined
    try {
      clientId = runtimeClientIdFromHeader(req)
    } catch (error) {
      sendControlError(res, error, req)
      return
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      if (!clientId) {
        rejectMissingRuntimeClient(res, req)
        return
      }
      let mutation
      try {
        mutation = registry.reserveMutation(clientId)
        rejectOversizedControlBody(req)
      } catch (error) {
        if (mutation) registry.releasePending(mutation)
        sendControlError(res, error, req)
        return
      }
      void readControlBody(req, controlBodyTimeoutMs)
        .then((body) => {
          if (!res.destroyed) enqueueControl(registry, clientId, req, res, defaults, body, mutation)
          else registry.releasePending(mutation)
        })
        .catch((error) => {
          registry.releasePending(mutation)
          sendControlError(res, error, req)
        })
      return
    }
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      res.setHeader('Allow', 'GET, PUT, POST, DELETE')
      sendControlError(res, new ControlRequestError(405, 'method not allowed'), req)
      return
    }
    if (!clientId) {
      if (req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store')
        sendJson(res, 200, publicRuntime(defaults, defaults))
      } else rejectMissingRuntimeClient(res, req)
      return
    }
    if (req.method === 'DELETE') {
      let mutation
      try {
        mutation = registry.reserveMutation(clientId)
      } catch (error) {
        sendControlError(res, error, req)
        return
      }
      enqueueControl(registry, clientId, req, res, defaults, undefined, mutation)
      return
    }
    enqueueControl(registry, clientId, req, res, defaults)
  }

  return { handle, handleUpgrade, attach, close }
}

export function mesGatewayPlugin(options: GatewayProxyOptions): Plugin {
  const proxy = createGatewayProxy(options)
  const attach = (middlewares: Connect.Server, httpServer: UpgradeCapableServer | null) => {
    proxy.attach(httpServer)
    middlewares.use(proxy.handle)
    httpServer?.on('upgrade', (req, socket, head) => {
      proxy.handleUpgrade(req, socket, head)
    })
  }
  return {
    name: 'mes-gateway-proxy',
    configureServer(server) {
      attach(server.middlewares, server.httpServer)
    },
    configurePreviewServer(server) {
      attach(server.middlewares, server.httpServer)
    },
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

function allowRequest(req: http.IncomingMessage) {
  return isLoopbackAddress(req.socket.remoteAddress) && requestHostIsLoopback(req.headers.host)
}

function requestHostIsLoopback(host: string | undefined) {
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/gu, '')
    return hostname === 'localhost' || isLoopbackAddress(hostname)
  } catch {
    return false
  }
}

function statusText(status: number) {
  if (status === 400) return 'Bad Request'
  if (status === 403) return 'Forbidden'
  if (status === 405) return 'Method Not Allowed'
  if (status === 409) return 'Conflict'
  return 'Service Unavailable'
}
