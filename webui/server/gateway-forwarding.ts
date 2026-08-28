import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import { RUNTIME_CLIENT_HEADER, RUNTIME_CLIENT_QUERY } from '../src/shared/api/runtime-client.ts'
import type { GatewayRuntime } from './gateway-runtime.ts'
import { sendJson } from './gateway-control.ts'

const HTTP_TIMEOUT_MS = 120_000
const WS_HANDSHAKE_TIMEOUT_MS = 15_000
const REQUEST_HEADERS_TO_DROP = new Set([
  'authorization',
  'connection',
  'cookie',
  'cookie2',
  'forwarded',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  RUNTIME_CLIENT_HEADER.toLowerCase(),
])
const RESPONSE_HEADERS_TO_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function requestPath(url: string | undefined) {
  return (url ?? '').split('?', 1)[0] ?? ''
}

function stripRuntimeClientQuery(url: string | undefined) {
  const raw = url ?? '/'
  const hashIndex = raw.indexOf('#')
  const withoutHash = hashIndex === -1 ? raw : raw.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex === -1) return withoutHash || '/'
  const pathname = withoutHash.slice(0, queryIndex) || '/'
  const query = withoutHash.slice(queryIndex + 1)
  const retained = query.split('&').filter((part) => {
    const key = part.split('=', 1)[0] ?? ''
    try {
      return decodeURIComponent(key.replace(/\+/gu, ' ')) !== RUNTIME_CLIENT_QUERY
    } catch {
      return true
    }
  })
  return retained.length ? `${pathname}?${retained.join('&')}` : pathname
}

export function isApiPath(path: string) {
  return (
    path === '/api' || path.startsWith('/api/') || path === '/auth' || path.startsWith('/auth/')
  )
}

export function isReadOnlyHttpMethod(method: string | undefined) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

export function isWsPath(path: string) {
  return path === '/api' || path.startsWith('/api/')
}

export function isWebSocketUpgrade(req: http.IncomingMessage) {
  const upgrade = req.headers.upgrade
  return (
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    connectionTokens(req.headers.connection).includes('upgrade')
  )
}

function targetOf(origin: string) {
  const url = new URL(origin)
  const tls = url.protocol === 'https:'
  return {
    tls,
    hostname: url.hostname,
    port: Number(url.port || (tls ? 443 : 80)),
    lib: tls ? https : http,
  }
}

function proxyHeaders(
  req: http.IncomingMessage,
  runtime: GatewayRuntime,
  websocket: boolean,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  if (websocket) {
    for (const name of [
      'sec-websocket-extensions',
      'sec-websocket-key',
      'sec-websocket-protocol',
      'sec-websocket-version',
      'user-agent',
    ]) {
      const value = req.headers[name]
      if (value !== undefined) headers[name] = value
    }
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
  } else {
    const dropped = new Set(REQUEST_HEADERS_TO_DROP)
    for (const name of connectionTokens(req.headers.connection)) dropped.add(name)
    for (const [name, value] of Object.entries(req.headers)) {
      if (!dropped.has(name.toLowerCase())) headers[name] = value
    }
  }
  headers.host = runtime.host
  headers.origin = `${new URL(runtime.origin).protocol}//${runtime.host}`
  if (runtime.token) headers.authorization = `Bearer ${runtime.token}`
  return headers
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const sanitized: http.OutgoingHttpHeaders = {}
  const dropped = new Set(RESPONSE_HEADERS_TO_DROP)
  for (const name of connectionTokens(headers.connection)) dropped.add(name)
  for (const [name, value] of Object.entries(headers)) {
    if (!dropped.has(name.toLowerCase())) sanitized[name] = value
  }
  return sanitized
}

function connectionTokens(value: string | string[] | undefined) {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values
    .flatMap((item) => item.split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

export function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: GatewayRuntime,
  onResponse?: (status: number) => void,
) {
  const target = targetOf(runtime.origin)
  let proxyRequest: http.ClientRequest
  let proxyResponse: http.IncomingMessage | undefined
  let clientClosed = false
  const closeUpstream = () => {
    clientClosed = true
    proxyResponse?.destroy()
    proxyRequest.destroy()
  }
  try {
    proxyRequest = target.lib.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: stripRuntimeClientQuery(req.url),
        method: req.method,
        headers: proxyHeaders(req, runtime, false),
      },
      (response) => {
        proxyResponse = response
        onResponse?.(response.statusCode ?? 502)
        response.once('aborted', () => {
          if (!res.writableEnded) res.destroy()
        })
        response.once('error', (error) => {
          if (!res.writableEnded) res.destroy(error)
        })
        response.once('close', () => {
          if (!res.writableEnded) res.destroy()
        })
        if (clientClosed || res.destroyed) {
          response.destroy()
          return
        }
        res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers))
        response.pipe(res)
      },
    )
  } catch {
    sendJson(res, 502, { error: 'gateway request could not be created' })
    return
  }
  proxyRequest.setTimeout(HTTP_TIMEOUT_MS, () => {
    proxyRequest.destroy(new Error('gateway request timed out'))
  })
  proxyRequest.on('error', (error) => {
    if (clientClosed || res.destroyed) return
    if (!res.headersSent) sendJson(res, 502, { error: error.message })
    else res.destroy(error)
  })
  req.once('aborted', closeUpstream)
  res.once('close', () => {
    if (!res.writableEnded) closeUpstream()
  })
  req.pipe(proxyRequest)
}

export function forwardWs(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtime: GatewayRuntime,
  onSettled?: () => void,
  onResponse?: (status: number) => void,
) {
  const target = targetOf(runtime.origin)
  let proxyRequest: http.ClientRequest
  let proxySocket: Duplex | undefined
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    onSettled?.()
  }
  const closeBoth = () => {
    proxyRequest.destroy()
    proxySocket?.destroy()
    if (!socket.destroyed) socket.destroy()
    settle()
  }
  try {
    proxyRequest = target.lib.request({
      hostname: target.hostname,
      port: target.port,
      path: stripRuntimeClientQuery(req.url),
      method: 'GET',
      headers: proxyHeaders(req, runtime, true),
    })
  } catch {
    socket.destroy()
    settle()
    return
  }
  proxyRequest.setTimeout(WS_HANDSHAKE_TIMEOUT_MS, () => {
    proxyRequest.destroy(new Error('gateway websocket handshake timed out'))
  })
  proxyRequest.on('upgrade', (proxyResponse, upstreamSocket, proxyHead) => {
    proxyRequest.setTimeout(0)
    onResponse?.(proxyResponse.statusCode ?? 101)
    const lines = ['HTTP/1.1 101 Switching Protocols']
    const allowedResponseHeaders = new Set([
      'connection',
      'sec-websocket-accept',
      'sec-websocket-extensions',
      'sec-websocket-protocol',
      'upgrade',
    ])
    for (const [key, value] of Object.entries(proxyResponse.headers)) {
      if (!allowedResponseHeaders.has(key.toLowerCase())) continue
      if (value == null) continue
      if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`))
      else lines.push(`${key}: ${value}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    proxySocket = upstreamSocket
    if (head.length) upstreamSocket.write(head)
    if (proxyHead.length) socket.write(proxyHead)
    upstreamSocket.once('error', closeBoth)
    upstreamSocket.once('close', closeBoth)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  proxyRequest.on('response', (proxyResponse) => {
    onResponse?.(proxyResponse.statusCode ?? 502)
    socket.write(
      `HTTP/1.1 ${proxyResponse.statusCode ?? 502} ${proxyResponse.statusMessage ?? 'Bad Gateway'}\r\n`,
    )
    for (const [key, value] of Object.entries(responseHeaders(proxyResponse.headers))) {
      if (value == null) continue
      socket.write(`${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
    }
    socket.write('\r\n')
    proxyResponse.once('error', closeBoth)
    proxyResponse.once('close', closeBoth)
    proxyResponse.pipe(socket)
  })
  proxyRequest.once('error', closeBoth)
  socket.once('error', closeBoth)
  socket.once('close', () => {
    proxyRequest.destroy()
    proxySocket?.destroy()
    settle()
  })
  proxyRequest.end()
}

export function writeSocketError(socket: Duplex, status: number, statusText: string) {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`)
}
