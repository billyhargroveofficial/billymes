import { execFile } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTROL_PATH } from './gateway-control.ts'
import {
  forwardHttp,
  forwardWs,
  isWebSocketUpgrade,
  isWsPath,
  requestPath,
  writeSocketError,
} from './gateway-forwarding.ts'
import { isLoopbackAddress } from './gateway-runtime.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_TTL_S = 30 * 24 * 3600
const TOKEN_SLACK_S = 300
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
])
export function productionOptions(env = process.env) {
  const origin = normalizeHttpOrigin(env.HERMES_PROXY_TARGET ?? 'http://127.0.0.1:9119')
  const accessKeyHash = (env.ACCESS_KEY_SHA256 ?? '').toLowerCase()
  const sessionSecret = env.SESSION_SECRET ?? ''
  if (!/^[0-9a-f]{64}$/u.test(accessKeyHash) || sessionSecret.length < 32) {
    throw new Error(
      'ACCESS_KEY_SHA256 (SHA-256 hex) and SESSION_SECRET (32+ characters) are required',
    )
  }
  return {
    host: normalizeLoopbackHost(env.HERMES_UI_HOST ?? '127.0.0.1'),
    port: normalizePort(env.HERMES_UI_PORT ?? '9219'),
    gateway: { origin, host: env.HERMES_DASHBOARD_HOST?.trim() || new URL(origin).host },
    accessKeyHash,
    sessionSecret,
    python: env.HERMES_PYTHON || 'python3',
    secretsFile: env.BILLYMES_SECRETS_FILE || '',
  }
}

export function createProductionServer({
  distDir = path.join(root, 'dist'),
  gateway,
  accessKeyHash,
  sessionSecret,
  gatewayToken,
} = {}) {
  if (!gateway || !accessKeyHash || !sessionSecret)
    throw new Error('production server options are required')
  const session = createSessionBoundary(accessKeyHash, sessionSecret)
  const tokens = gatewayToken ?? createGatewayTokenProvider()
  const runtime = { ...gateway, token: '' }
  const server = http.createServer(async (req, res) => {
    const pathname = requestPath(req.url)
    try {
      if (pathname === '/__health') return respond(res, 204, '')
      // This dev-only endpoint must never turn into a login HTML response.
      if (pathname === CONTROL_PATH) return respond(res, 404, 'not found')
      if (pathname === '/__access' && req.method === 'POST') {
        const key = await readAccessKey(req)
        if (!key || !session.keyMatches(key)) return rejectAccess(res)
        res.writeHead(204, { 'Set-Cookie': session.makeCookie() })
        return res.end()
      }
      if (!session.cookieValid(req.headers.cookie)) {
        if (isApiRequest(pathname)) return respond(res, 401, 'key required')
        return loginPage(res)
      }
      if (isApiRequest(pathname)) {
        let token
        try {
          token = await tokens.get()
        } catch {
          return respond(res, 502, 'gateway authentication unavailable')
        }
        forwardHttp(req, res, { ...runtime, token }, (status) => {
          if (status === 401) tokens.invalidate()
        })
        return
      }
      return await serveStatic(req, res, distDir)
    } catch {
      if (!res.destroyed) respond(res, 500, 'internal error')
    }
  })
  server.on('upgrade', async (req, socket, head) => {
    const pathname = requestPath(req.url)
    // Gate path and WebSocket syntax before attempting a token mint.
    if (!isWsPath(pathname)) return writeSocketError(socket, 404, 'Not Found')
    if (!isWebSocketUpgrade(req)) return writeSocketError(socket, 400, 'Bad Request')
    if (!session.cookieValid(req.headers.cookie))
      return writeSocketError(socket, 401, 'Unauthorized')
    let token
    try {
      token = await tokens.get()
    } catch {
      return writeSocketError(socket, 502, 'Bad Gateway')
    }
    forwardWs(req, socket, head, { ...runtime, token }, undefined, (status) => {
      if (status === 401) tokens.invalidate()
    })
  })
  return server
}

export function createGatewayTokenProvider({ python = 'python3', secretsFile = '' } = {}) {
  let current = { token: '', expiresAt: 0 }
  let inFlight
  const mint = () =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, BILLYMES_REPO_ROOT: root }
      if (secretsFile) env.BILLYMES_SECRETS_FILE = secretsFile
      const child = execFile(
        python,
        ['-'],
        {
          cwd: root,
          env,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout) => {
          if (error) return reject(new Error('gateway session mint failed'))
          try {
            const parsed = JSON.parse(stdout)
            if (typeof parsed.access_token !== 'string' || !parsed.access_token)
              throw new Error('missing token')
            resolve({ token: parsed.access_token, expiresAt: Number(parsed.expires_at) || 0 })
          } catch {
            reject(new Error('gateway session mint returned invalid data'))
          }
        },
      )
      child.stdin.end(MINT_PY)
    })
  return {
    async get() {
      const now = Math.floor(Date.now() / 1000)
      if (current.token && current.expiresAt - now > TOKEN_SLACK_S) return current.token
      inFlight ??= mint()
        .then((next) => {
          current = next
          return next.token
        })
        .finally(() => {
          inFlight = undefined
        })
      return inFlight
    },
    invalidate() {
      current = { token: '', expiresAt: 0 }
    },
  }
}

function createSessionBoundary(accessKeyHash, sessionSecret) {
  // Bind the browser session to the current access-key digest. Rotating the
  // operator key must revoke every cookie minted for the old key immediately,
  // even when SESSION_SECRET itself is intentionally kept stable.
  const sign = (value) =>
    createHmac('sha256', sessionSecret)
      .update(`mes-session-v2\0${accessKeyHash}\0${value}`)
      .digest('hex')
  return {
    keyMatches(key) {
      const given = createHash('sha256').update(String(key)).digest()
      const wanted = Buffer.from(accessKeyHash, 'hex')
      return given.length === wanted.length && timingSafeEqual(given, wanted)
    },
    cookieValid(header) {
      const raw = /(?:^|;\s*)mes_session=([^;]+)/u.exec(header || '')?.[1]
      const [expiry, signature] = raw?.split('.') ?? []
      if (!expiry || !signature) return false
      const expected = Buffer.from(sign(expiry))
      const received = Buffer.from(signature)
      return (
        received.length === expected.length &&
        timingSafeEqual(received, expected) &&
        Number(expiry) > Math.floor(Date.now() / 1000)
      )
    },
    makeCookie() {
      const expiry = String(Math.floor(Date.now() / 1000) + SESSION_TTL_S)
      return `mes_session=${expiry}.${sign(expiry)}; Max-Age=${SESSION_TTL_S}; Path=/; HttpOnly; Secure; SameSite=Lax`
    },
  }
}

async function readAccessKey(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > 4096) return ''
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof body?.key === 'string' ? body.key : ''
  } catch {
    return ''
  }
}

function rejectAccess(res) {
  setTimeout(() => respond(res, 403, 'wrong key'), 400 + Math.floor(Math.random() * 301))
}

function isApiRequest(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/')
  )
}

function loginPage(res) {
  const nonce = randomBytes(18).toString('base64')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(LOGIN_HTML.replaceAll('__NONCE__', nonce))
}

function respond(res, status, text) {
  if (res.headersSent || res.destroyed) return res.destroy()
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(text)
}

async function serveStatic(req, res, distDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 404, 'not found')
  let pathname
  try {
    pathname = decodeURIComponent(requestPath(req.url) || '/')
  } catch {
    return respond(res, 400, 'bad request')
  }
  let base
  try {
    base = await realpath(path.resolve(distDir))
  } catch {
    return respond(res, 404, 'not found')
  }
  let file = path.resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`)
  if (file !== base && !file.startsWith(`${base}${path.sep}`)) return respond(res, 404, 'not found')
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(base, 'index.html')
  }
  try {
    file = await realpath(file)
    if (file !== base && !file.startsWith(`${base}${path.sep}`)) {
      return respond(res, 404, 'not found')
    }
    const body = await readFile(file)
    res.statusCode = 200
    res.setHeader('Content-Type', MIME_TYPES.get(path.extname(file)) ?? 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', appContentSecurityPolicy(req))
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader(
      'Cache-Control',
      file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    )
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    respond(res, 404, 'not found')
  }
}

function appContentSecurityPolicy(req) {
  const host = requestHost(req.headers.host)
  const socketSources = host ? ` ws://${host} wss://${host}` : ''
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src 'self'${socketSources}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "worker-src 'self' blob:",
  ].join('; ')
}

function requestHost(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || /[^\x21-\x7e]/u.test(value))
    return ''
  try {
    const parsed = new URL(`http://${value}`)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    )
      return ''
    return parsed.host
  } catch {
    return ''
  }
}

function normalizeHttpOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('HERMES_PROXY_TARGET must be an absolute HTTP(S) URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('HERMES_PROXY_TARGET must be a credential-free HTTP(S) origin')
  return url.origin
}

function normalizeLoopbackHost(value) {
  const host = value.trim().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || isLoopbackAddress(host)) return host
  throw new Error('HERMES_UI_HOST must be a loopback address')
}

function normalizePort(value) {
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535)
    throw new Error('HERMES_UI_PORT must be a valid TCP port')
  return Number(value)
}

const MINT_PY = `
import json, os, sys
from pathlib import Path

secrets = os.environ.get("BILLYMES_SECRETS_FILE")
if secrets:
    candidate = Path(secrets)
    if candidate.is_file():
        for line in candidate.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:]
            if "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

sys.path.insert(0, os.environ["BILLYMES_REPO_ROOT"])
from plugins.dashboard_auth.basic import BasicAuthProvider, _load_config_basic_auth_section, _resolve, _resolve_secret
section = _load_config_basic_auth_section()
username = _resolve("HERMES_DASHBOARD_BASIC_AUTH_USERNAME", section, "username")
password_hash = _resolve("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH", section, "password_hash")
provider = BasicAuthProvider(username=username, password_hash=password_hash, secret=_resolve_secret(section))
session = provider._mint_session(username)
print(json.dumps({"access_token": session.access_token, "expires_at": session.expires_at}))
`

const LOGIN_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Access required</title><style nonce="__NONCE__">body{font-family:system-ui;display:grid;min-height:100vh;place-items:center;margin:0;background:#101014;color:#e8e3d8}form{display:grid;gap:12px;width:min(320px,86vw)}input,button{font:inherit;padding:12px;border-radius:12px}input{background:#1a1a21;color:inherit;border:1px solid #33333d}button{border:0;background:#d7c4a3;color:#17130b}</style><form id="access"><input id="key" type="password" autocomplete="current-password" placeholder="Access key" autofocus><button>Continue</button><p id="error"></p></form><script nonce="__NONCE__">access.onsubmit=async e=>{e.preventDefault();const r=await fetch("/__access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key:key.value})}).catch(()=>null);if(r&&r.ok)location.reload();else error.textContent="Access denied"}</script></html>'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = productionOptions()
  const server = createProductionServer({
    ...options,
    gatewayToken: createGatewayTokenProvider(options),
  })
  server.listen(options.port, options.host, () =>
    process.stdout.write(`billymes-webui listening on loopback port ${options.port}\n`),
  )
  const stop = () => server.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
