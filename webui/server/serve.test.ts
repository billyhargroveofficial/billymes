import { createHash } from 'node:crypto'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error Production uses Node's native TypeScript loader for this ESM entrypoint.
import { createProductionServer, productionOptions } from './serve.mjs'

const accessKey = 'test-access-key'
const accessKeyHash = createHash('sha256').update(accessKey).digest('hex')
const sessionSecret = 'test-session-secret-with-at-least-thirty-two-characters'

async function listen(server: http.Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
  return address.port
}

async function close(server: http.Server) {
  server.close()
  await once(server, 'close')
}

function request(
  port: number,
  path: string,
  {
    method = 'GET',
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        )
      })
      req.once('error', reject)
      req.end(body)
    },
  )
}

function rawUpgrade(port: number, path: string, headers: string[] = []) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    let response = ''
    socket.once('connect', () =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          ...headers,
          '',
          '',
        ].join('\r\n'),
      ),
    )
    socket.on('data', (chunk) => (response += chunk.toString()))
    socket.once('error', reject)
    socket.once('close', () => resolve(response))
  })
}

async function fixture({
  token = 'minted-gateway-token',
  upstream,
  keyHash = accessKeyHash,
}: {
  token?: string
  upstream?: { origin: string; host: string }
  keyHash?: string
} = {}) {
  const distDir = await mkdtemp(path.join(os.tmpdir(), 'billymes-webui-'))
  await writeFile(path.join(distDir, 'index.html'), '<main>WebUI</main>')
  const tokens = { get: vi.fn(async () => token), invalidate: vi.fn() }
  const server = createProductionServer({
    distDir,
    gateway: upstream ?? { origin: 'http://127.0.0.1:1', host: 'gateway.test' },
    accessKeyHash: keyHash,
    sessionSecret,
    gatewayToken: tokens,
  })
  return { server, tokens }
}

describe('production WebUI server', () => {
  it('gates HTML and API access without exposing the gateway token', async () => {
    let observedAuthorization = ''
    const upstream = http.createServer((req, res) => {
      observedAuthorization = String(req.headers.authorization ?? '')
      res.end('upstream ok')
    })
    const upstreamPort = await listen(upstream)
    const { server, tokens } = await fixture({
      upstream: { origin: `http://127.0.0.1:${upstreamPort}`, host: 'gateway.test' },
    })
    const port = await listen(server)
    try {
      await expect(request(port, '/')).resolves.toMatchObject({
        status: 200,
        body: expect.stringContaining('Access required'),
      })
      await expect(request(port, '/api/status')).resolves.toMatchObject({
        status: 401,
        body: 'key required',
      })
      expect(tokens.get).not.toHaveBeenCalled()

      const wrong = await request(port, '/__access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'wrong' }),
      })
      expect(wrong.status).toBe(403)
      expect(wrong.body).not.toContain(accessKey)

      const login = await request(port, '/__access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: accessKey }),
      })
      expect(login.status).toBe(204)
      const cookie = login.headers['set-cookie']?.[0]
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      const api = await request(port, '/api/status', { headers: { Cookie: cookie ?? '' } })
      expect(api).toMatchObject({ status: 200, body: 'upstream ok' })
      expect(api.body).not.toContain('minted-gateway-token')
      expect(observedAuthorization).toBe('Bearer minted-gateway-token')

      const app = await request(port, '/', { headers: { Cookie: cookie ?? '' } })
      expect(app.headers['content-security-policy']).toContain("script-src 'self'")
      expect(app.headers['content-security-policy']).not.toContain("script-src 'unsafe-inline'")
      expect(app.headers['content-security-policy']).toContain(`ws://127.0.0.1:${port}`)
      expect(app.headers['content-security-policy']).not.toMatch(/connect-src[^;]*\sws:\s/u)
      expect(app.headers['x-frame-options']).toBe('DENY')
      expect(app.headers['referrer-policy']).toBe('no-referrer')
    } finally {
      await close(server)
      await close(upstream)
    }
  })

  it('rejects unauthorized WebSocket upgrades before minting a gateway token', async () => {
    const { server, tokens } = await fixture()
    const port = await listen(server)
    try {
      await expect(rawUpgrade(port, '/api/ws')).resolves.toContain('401 Unauthorized')
      await expect(rawUpgrade(port, '/not-gateway')).resolves.toContain('404 Not Found')
      expect(tokens.get).not.toHaveBeenCalled()
    } finally {
      await close(server)
    }
  })

  it('invalidates the cached minted token when the gateway rejects it', async () => {
    const upstream = http.createServer((_req, res) => {
      res.statusCode = 401
      res.end('expired')
    })
    const upstreamPort = await listen(upstream)
    const { server, tokens } = await fixture({
      upstream: { origin: `http://127.0.0.1:${upstreamPort}`, host: 'gateway.test' },
    })
    const port = await listen(server)
    try {
      const login = await request(port, '/__access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: accessKey }),
      })
      const cookie = login.headers['set-cookie']?.[0] ?? ''
      await expect(
        request(port, '/api/status', { headers: { Cookie: cookie } }),
      ).resolves.toMatchObject({
        status: 401,
      })
      expect(tokens.invalidate).toHaveBeenCalledOnce()
    } finally {
      await close(server)
      await close(upstream)
    }
  })

  it('keeps the development control endpoint absent after access is granted', async () => {
    const { server } = await fixture()
    const port = await listen(server)
    try {
      await expect(request(port, '/__mes/gateway')).resolves.toMatchObject({ status: 404 })
      await expect(
        request(port, '/chat/any', { headers: { Cookie: 'mes_session=bad' } }),
      ).resolves.toMatchObject({ status: 200, body: expect.stringContaining('Access required') })
    } finally {
      await close(server)
    }
  })

  it('revokes existing browser sessions when the access key is rotated', async () => {
    const first = await fixture()
    const firstPort = await listen(first.server)
    const login = await request(firstPort, '/__access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: accessKey }),
    })
    const oldCookie = login.headers['set-cookie']?.[0] ?? ''
    await close(first.server)

    const rotatedHash = createHash('sha256').update('rotated-access-key').digest('hex')
    const rotated = await fixture({ keyHash: rotatedHash })
    const rotatedPort = await listen(rotated.server)
    try {
      const response = await request(rotatedPort, '/', { headers: { Cookie: oldCookie } })
      expect(response.status).toBe(200)
      expect(response.body).toContain('Access required')
      expect(rotated.tokens.get).not.toHaveBeenCalled()
    } finally {
      await close(rotated.server)
    }
  })

  it('does not follow static-file symlinks outside the built asset directory', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'billymes-outside-'))
    const secret = path.join(outside, 'private.txt')
    await writeFile(secret, 'must not be served')
    const distDir = await mkdtemp(path.join(os.tmpdir(), 'billymes-dist-'))
    await writeFile(path.join(distDir, 'index.html'), '<main>fallback</main>')
    await symlink(secret, path.join(distDir, 'escape.txt'))
    const tokens = { get: vi.fn(async () => 'unused-token'), invalidate: vi.fn() }
    const server = createProductionServer({
      distDir,
      gateway: { origin: 'http://127.0.0.1:1', host: 'gateway.test' },
      accessKeyHash,
      sessionSecret,
      gatewayToken: tokens,
    })
    const port = await listen(server)
    try {
      const login = await request(port, '/__access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: accessKey }),
      })
      const cookie = login.headers['set-cookie']?.[0] ?? ''
      const response = await request(port, '/escape.txt', { headers: { Cookie: cookie } })
      expect(response.status).toBe(404)
      expect(response.body).not.toContain('must not be served')
    } finally {
      await close(server)
    }
  })

  it('requires externally supplied authentication material and only accepts loopback listeners', () => {
    expect(() => productionOptions({ HERMES_UI_HOST: '0.0.0.0' })).toThrow('ACCESS_KEY_SHA256')
    expect(() =>
      productionOptions({
        HERMES_UI_HOST: '0.0.0.0',
        ACCESS_KEY_SHA256: accessKeyHash,
        SESSION_SECRET: sessionSecret,
      }),
    ).toThrow('loopback')
  })
})
