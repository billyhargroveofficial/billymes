import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'

import { describe, expect, it } from 'vitest'
import {
  MAX_CONTROL_BODY_BYTES,
  mesGatewayPlugin,
  isLoopbackAddress,
  normalizeHost,
  normalizeOrigin,
  normalizeRuntime,
  normalizeToken,
} from './gateway-proxy'
import type { GatewayRuntime } from './gateway-runtime.ts'
import { RUNTIME_CLIENT_HEADER } from '../src/shared/api/runtime-client'

type TestResponse = {
  status: number
  body: Record<string, unknown>
}

type RuntimeOptions = {
  runtimeClientTtlMs?: number
  maxRuntimeClients?: number
}

function createGatewayServer(
  controlBodyTimeoutMs = 50,
  runtimeOptions: RuntimeOptions = {},
  defaults: GatewayRuntime = { origin: 'http://gateway.test', host: 'gateway.test', token: '' },
) {
  const handlers: ConnectMiddleware[] = []
  const server = http.createServer((req, res) => {
    let index = 0
    const next = () => {
      const handler = handlers[index]
      index += 1
      if (handler) {
        handler(req, res, next)
        return
      }
      res.statusCode = 404
      res.end()
    }
    next()
  })
  const plugin = mesGatewayPlugin({
    defaults,
    controlBodyTimeoutMs,
    ...runtimeOptions,
  })
  const configureServer = plugin.configureServer
  if (typeof configureServer === 'function') {
    configureServer.call(
      undefined as never,
      {
        middlewares: {
          use(handler: ConnectMiddleware) {
            handlers.push(handler)
          },
        },
        httpServer: server,
      } as never,
    )
  }
  return server
}

type ConnectMiddleware = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  next: () => void,
) => void

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
  return address.port
}

async function close(server: http.Server) {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

function controlRequest(
  port: number,
  method: string,
  headers: Record<string, string> = {},
  body?: string,
  clientId: string | null = 'runtime-fixture-1',
  includeOrigin = true,
) {
  return new Promise<TestResponse>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/__mes/gateway',
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(includeOrigin ? { Origin: `http://127.0.0.1:${port}` } : {}),
          ...(clientId ? { [RUNTIME_CLIENT_HEADER]: clientId } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    request.on('error', reject)
    if (body !== undefined) request.end(body)
    else request.end()
  })
}

function apiRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  includeOrigin = true,
) {
  return new Promise<{
    status: number
    headers: http.IncomingHttpHeaders
    body: string
  }>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(includeOrigin ? { Origin: `http://127.0.0.1:${port}` } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end()
  })
}

function websocketRequest(port: number, path: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let response = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      callback()
      socket.destroy()
    }
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Origin: http://127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          'X-Mes-Runtime: runtime-header-should-not-forward',
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8')
      if (response.includes('\r\n\r\n')) finish(() => resolve(response))
    })
    socket.on('error', (error) => finish(() => reject(error)))
    socket.on('close', () => {
      if (!settled) reject(new Error('WebSocket proxy closed before handshake'))
    })
  })
}

describe('gateway proxy validation', () => {
  it('normalizes HTTP origins and rejects credential or path-bearing targets', () => {
    expect(normalizeOrigin('https://gateway.test:9443/')).toBe('https://gateway.test:9443')
    expect(() => normalizeOrigin('file:///tmp/socket')).toThrow('http or https')
    expect(() => normalizeOrigin('https://user:secret@gateway.test')).toThrow('credentials')
    expect(() => normalizeOrigin('https://gateway.test/private')).toThrow('must not contain')
  })

  it('validates Host independently from the transport target', () => {
    expect(normalizeHost('', 'https://gateway.test:9443')).toBe('gateway.test:9443')
    expect(normalizeHost('dashboard.internal:9119', 'https://gateway.test')).toBe(
      'dashboard.internal:9119',
    )
    expect(() =>
      normalizeHost('safe.test\r\nAuthorization: leaked', 'https://gateway.test'),
    ).toThrow('invalid gateway host')
  })

  it('rejects control characters and oversized bearer values', () => {
    expect(normalizeToken('header.payload-signature_123')).toBe('header.payload-signature_123')
    expect(() => normalizeToken('token\r\nX-Evil: yes')).toThrow('invalid characters')
    expect(() => normalizeToken('x'.repeat(16_385))).toThrow('invalid characters')
    expect(() => normalizeToken(42)).toThrow('must be a string')
  })

  it('recognizes IPv4, mapped IPv4, and IPv6 loopback only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.2.3.4')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('192.0.2.10')).toBe(false)
  })

  it('rejects requests without Origin unless same-origin fetch metadata is present', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const rejected = await controlRequest(port, 'GET', {}, undefined, null, false)
      expect(rejected.status).toBe(403)
      const accepted = await controlRequest(
        port,
        'GET',
        { 'Sec-Fetch-Site': 'same-origin' },
        undefined,
        null,
        false,
      )
      expect(accepted.status).toBe(200)
    } finally {
      await close(server)
    }
  })

  it('normalizes a complete runtime at startup', () => {
    expect(
      normalizeRuntime({ origin: 'http://127.0.0.1:9119/', host: '', token: 'token' }),
    ).toEqual({ origin: 'http://127.0.0.1:9119', host: '127.0.0.1:9119', token: 'token' })
  })
})

describe('gateway control body lifecycle', () => {
  it('keeps slow mutation bodies out of the mutation FIFO', async () => {
    const server = createGatewayServer(100)
    const port = await listen(server)
    const slow = beginIncompleteControlRequest(port)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const get = controlRequest(port, 'GET', {}, undefined, 'runtime-slow-client')
      const first = await Promise.race([
        get.then((result) => ({ kind: 'get' as const, result })),
        slow.outcome.then((outcome) => ({ kind: 'slow' as const, outcome })),
      ])
      expect(first.kind).toBe('get')
      if (first.kind === 'get') {
        expect(first.result.status).toBe(200)
        expect(first.result.body.origin).toBe('http://gateway.test')
      }

      const outcome = await slow.outcome
      if ('status' in outcome) expect(outcome.status).toBe(408)
    } finally {
      slow.request.destroy()
      await close(server)
    }
  })

  it('rejects a declared oversized body before it can enter the FIFO', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const rejected = await controlRequest(
        port,
        'PUT',
        { 'Content-Length': String(MAX_CONTROL_BODY_BYTES + 1) },
        '',
      )
      expect(rejected.status).toBe(413)
      const current = await controlRequest(port, 'GET')
      expect(current.status).toBe(200)
      expect(current.body.origin).toBe('http://gateway.test')
    } finally {
      await close(server)
    }
  })

  it('applies a complete mutation after its body has been collected', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const updated = await controlRequest(
        port,
        'PUT',
        { 'Content-Type': 'application/json' },
        JSON.stringify({ origin: 'https://next.gateway.test:9443', token: 'session-token' }),
      )
      expect(updated.status).toBe(200)
      expect(updated.body.origin).toBe('https://next.gateway.test:9443')
      expect(updated.body.tokenSet).toBe(true)
      const current = await controlRequest(port, 'GET')
      expect(current.body.origin).toBe('https://next.gateway.test:9443')
      expect(current.body.tokenSet).toBe(true)
    } finally {
      await close(server)
    }
  })

  it('keeps mutable runtime state isolated between validated client identities', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const updated = await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://client-a.gateway.test', token: 'client-a-token' }),
        'runtime-client-a-1234',
      )
      expect(updated.status).toBe(200)
      expect(updated.body.tokenSet).toBe(true)

      const sameClient = await controlRequest(port, 'GET', {}, undefined, 'runtime-client-a-1234')
      const otherClient = await controlRequest(port, 'GET', {}, undefined, 'runtime-client-b-1234')
      expect(sameClient.body.origin).toBe('https://client-a.gateway.test')
      expect(otherClient.body.origin).toBe('http://gateway.test')
      expect(otherClient.body.tokenSet).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('resets an omitted token when a client changes the upstream host', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({
          origin: 'https://gateway.test',
          host: 'dashboard-a.gateway.test',
          token: 'old-token',
        }),
        'runtime-host-change-1',
      )
      const changed = await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://gateway.test', host: 'dashboard-b.gateway.test' }),
        'runtime-host-change-1',
      )
      expect(changed.status).toBe(200)
      expect(changed.body.origin).toBe('https://gateway.test')
      expect(changed.body.tokenSet).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('makes control mutations without a client identity fail closed', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const rejected = await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://unbound.gateway.test', token: 'must-not-stick' }),
        null,
      )
      expect(rejected.status).toBe(403)
      const defaults = await controlRequest(port, 'GET', {}, undefined, null)
      expect(defaults.status).toBe(200)
      expect(defaults.body.origin).toBe('http://gateway.test')
      expect(defaults.body.tokenSet).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('expires idle clients and evicts the oldest client at the configured bound', async () => {
    const server = createGatewayServer(50, { runtimeClientTtlMs: 20, maxRuntimeClients: 1 })
    const port = await listen(server)
    try {
      await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://first.gateway.test' }),
        'runtime-first-client',
      )
      const evicted = await controlRequest(port, 'GET', {}, undefined, 'runtime-second-client')
      expect(evicted.body.origin).toBe('http://gateway.test')
      const firstAfterEviction = await controlRequest(
        port,
        'GET',
        {},
        undefined,
        'runtime-first-client',
      )
      expect(firstAfterEviction.body.origin).toBe('http://gateway.test')

      await new Promise((resolve) => setTimeout(resolve, 25))
      const expired = await controlRequest(port, 'GET', {}, undefined, 'runtime-second-client')
      expect(expired.body.origin).toBe('http://gateway.test')
    } finally {
      await close(server)
    }
  })

  it('does not evict a client while its control body is still pending', async () => {
    const server = createGatewayServer(500, { maxRuntimeClients: 1 })
    const port = await listen(server)
    const slow = beginIncompleteControlRequest(port)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const rejected = await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://second.gateway.test' }),
        'runtime-second-client',
      )
      expect(rejected.status).toBe(503)

      slow.request.end('"origin":"https://first.gateway.test"}')
      const completed = await slow.outcome
      if ('status' in completed) expect(completed.status).toBe(200)
      else throw completed.error
    } finally {
      slow.request.destroy()
      await close(server)
    }
  })

  it('supersedes an older body that completes after a newer mutation', async () => {
    const server = createGatewayServer(500)
    const port = await listen(server)
    const slow = beginIncompleteControlRequest(port)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const newer = await controlRequest(
        port,
        'PUT',
        {},
        JSON.stringify({ origin: 'https://newer.gateway.test', token: 'newer-token' }),
        'runtime-slow-client',
      )
      expect(newer.status).toBe(200)

      slow.request.end('"origin":"https://older.gateway.test","token":"old-token"}')
      const older = await slow.outcome
      if ('status' in older) expect(older.status).toBe(409)
      else throw older.error

      const current = await controlRequest(port, 'GET', {}, undefined, 'runtime-slow-client')
      expect(current.status).toBe(200)
      expect(current.body.origin).toBe('https://newer.gateway.test')
      expect(current.body.tokenSet).toBe(true)
    } finally {
      slow.request.destroy()
      await close(server)
    }
  })

  it('rejects malformed client identities instead of creating registry entries', async () => {
    const server = createGatewayServer()
    const port = await listen(server)
    try {
      const response = await controlRequest(port, 'GET', { [RUNTIME_CLIENT_HEADER]: 'too-short' })
      expect(response.status).toBe(400)
      expect(response.body.error).toBe('invalid runtime client id')
    } finally {
      await close(server)
    }
  })
})

describe('gateway forwarding runtime boundary', () => {
  it('uses the selected client runtime and strips internal request metadata upstream', async () => {
    let observedUrl = ''
    let observedHeaders: http.IncomingHttpHeaders = {}
    const upstream = http.createServer((req, res) => {
      observedUrl = req.url ?? ''
      observedHeaders = req.headers
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
    })
    const upstreamPort = await listen(upstream)
    const proxy = createGatewayServer(
      50,
      {},
      {
        origin: `http://127.0.0.1:${upstreamPort}`,
        host: 'upstream.gateway.test',
        token: 'server-token',
      },
    )
    const proxyPort = await listen(proxy)
    try {
      const rejectedMutation = await apiRequest(proxyPort, '/api/mutate', {}, 'POST')
      expect(rejectedMutation.status).toBe(403)
      const response = await apiRequest(
        proxyPort,
        '/api/health?keep=1&__mes_runtime=runtime-client-a-1234&ticket=hello%20world',
        {
          [RUNTIME_CLIENT_HEADER]: 'runtime-client-a-1234',
          Authorization: 'Bearer attacker-token',
          Cookie: 'session=attacker',
        },
      )
      expect(response.status).toBe(200)
      expect(observedUrl).toBe('/api/health?keep=1&ticket=hello%20world')
      expect(observedHeaders[RUNTIME_CLIENT_HEADER.toLowerCase()]).toBeUndefined()
      expect(observedHeaders.authorization).toBe('Bearer server-token')
      expect(observedHeaders.cookie).toBeUndefined()
      expect(observedHeaders.origin).toBe('http://upstream.gateway.test')
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  it('uses the WebSocket query identity and strips it before the upstream handshake', async () => {
    let observedUrl = ''
    let observedHeaders: http.IncomingHttpHeaders = {}
    let upstreamSocket: { destroy: () => void } | undefined
    const upstream = http.createServer()
    upstream.on('upgrade', (req, socket) => {
      upstreamSocket = socket
      observedUrl = req.url ?? ''
      observedHeaders = req.headers
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Accept: test',
          '',
          '',
        ].join('\r\n'),
      )
    })
    const upstreamPort = await listen(upstream)
    const proxy = createGatewayServer(
      50,
      {},
      {
        origin: `http://127.0.0.1:${upstreamPort}`,
        host: 'upstream.gateway.test',
        token: 'server-token',
      },
    )
    const proxyPort = await listen(proxy)
    try {
      const missingIdentity = await websocketRequest(proxyPort, '/api/ws?ticket=websocket-ticket')
      expect(missingIdentity).toContain('403 Forbidden')
      const response = await websocketRequest(
        proxyPort,
        '/api/ws?ticket=websocket-ticket&__mes_runtime=runtime-websocket-1',
      )
      expect(response).toContain('101 Switching Protocols')
      expect(observedUrl).toBe('/api/ws?ticket=websocket-ticket')
      expect(observedHeaders[RUNTIME_CLIENT_HEADER.toLowerCase()]).toBeUndefined()
      expect(observedHeaders.authorization).toBe('Bearer server-token')
      expect(observedHeaders.host).toBe('upstream.gateway.test')
    } finally {
      upstreamSocket?.destroy()
      await close(proxy)
      await close(upstream)
    }
  })
})

type SlowOutcome = { status: number } | { error: Error }

function beginIncompleteControlRequest(port: number) {
  let settle: (outcome: SlowOutcome) => void = () => undefined
  const outcome = new Promise<SlowOutcome>((resolve) => {
    settle = resolve
  })
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: '/__mes/gateway',
    method: 'PUT',
    headers: {
      Host: `127.0.0.1:${port}`,
      Origin: `http://127.0.0.1:${port}`,
      [RUNTIME_CLIENT_HEADER]: 'runtime-slow-client',
      'Content-Type': 'application/json',
    },
  })
  request.once('response', (response) => {
    response.resume()
    response.once('end', () => settle({ status: response.statusCode ?? 0 }))
  })
  request.once('error', (error) => settle({ error }))
  request.write('{')
  return { request, outcome }
}
