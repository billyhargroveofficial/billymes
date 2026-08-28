import {
  createRequestSignal,
  expectBoolean,
  expectRecord,
  expectString,
  runtimeClientHeaders,
} from '@/shared/api'

type GatewayMode = 'local' | 'remote'

export type GatewaySettings = {
  mode: GatewayMode
  origin: string
  host: string
  token: string
}

export type GatewayRuntimeInfo = {
  origin: string
  host: string
  tokenSet: boolean
  usingDefault: boolean
}

const SETTINGS_KEY = 'mes.gateway'
const TOKEN_KEY = 'mes.gateway-token'

type StoredToken = {
  origin: string
  host: string
  token: string
}

const emptyGatewaySettings = (): GatewaySettings => ({
  mode: 'local',
  origin: '',
  host: '',
  token: '',
})

export function readGatewaySettings(): GatewaySettings {
  let parsed: Partial<GatewaySettings>
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) {
      clearSessionToken()
      return emptyGatewaySettings()
    }
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      clearSessionToken()
      return emptyGatewaySettings()
    }
    parsed = value as Partial<GatewaySettings>
  } catch {
    clearSessionToken()
    return emptyGatewaySettings()
  }

  const mode = parsed.mode === 'remote' ? 'remote' : 'local'
  const origin = String(parsed.origin || '')
  const host = String(parsed.host || '')
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode, origin, host }))
  } catch {
    /* Storage can be unavailable, but the in-memory settings remain usable. */
  }
  if (mode === 'local') {
    clearSessionToken()
    return { mode, origin, host, token: '' }
  }

  let token = ''
  try {
    token = readStoredToken(sessionStorage.getItem(TOKEN_KEY), origin, host)
    if (token && origin) {
      writeStoredToken({
        origin: canonicalOrigin(origin),
        host: canonicalHost(host, origin),
        token,
      })
    } else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* Storage can be unavailable, but the in-memory settings remain usable. */
  }
  return {
    mode,
    origin,
    host,
    token,
  }
}

export function writeGatewaySettings(settings: GatewaySettings) {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ mode: settings.mode, origin: settings.origin, host: settings.host }),
    )
  } catch {
    /* ignore */
  }
  try {
    if (settings.mode === 'remote' && settings.token && settings.origin) {
      writeStoredToken({
        origin: canonicalOrigin(settings.origin),
        host: canonicalHost(settings.host, settings.origin),
        token: settings.token,
      })
    } else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

function canonicalOrigin(origin: string) {
  try {
    return new URL(origin).origin
  } catch {
    return origin.trim().replace(/\/+$/u, '')
  }
}

function canonicalHost(host: string, origin: string) {
  const candidate = host.trim() || hostFromOrigin(origin)
  try {
    return new URL(`http://${candidate}`).host
  } catch {
    return candidate
  }
}

function readStoredToken(raw: string | null, origin: string, host: string) {
  if (!raw) return ''
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
    const record = value as Record<string, unknown>
    return record.origin === canonicalOrigin(origin) &&
      record.host === canonicalHost(host, origin) &&
      typeof record.token === 'string'
      ? record.token
      : ''
  } catch {
    // Unbound or malformed session values are deliberately discarded.
    return ''
  }
}

function writeStoredToken(stored: StoredToken) {
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(stored))
}

function clearSessionToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function hostFromOrigin(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return ''
  }
}

export async function pushGatewaySettings(settings: GatewaySettings, signal?: AbortSignal) {
  const request = createRequestSignal(signal)
  try {
    if (settings.mode === 'local') {
      const res = await fetch('/__mes/gateway', {
        method: 'DELETE',
        headers: runtimeClientHeaders(),
        signal: request.signal,
      })
      // The production wrapper deliberately omits the dev control plane. Its
      // fixed same-origin runtime is still a healthy local-mode configuration.
      if (res.status === 204 || res.status === 404) return null
      if (!res.ok) throw new Error(`gateway reset failed (${res.status})`)
      return parseGatewayRuntime(await res.json())
    }
    const origin = settings.origin.replace(/\/$/, '')
    if (!origin) throw new Error('нужен URL гейтвея')
    const res = await fetch('/__mes/gateway', {
      method: 'PUT',
      headers: runtimeClientHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        origin,
        host: settings.host || hostFromOrigin(origin),
        token: settings.token,
      }),
      signal: request.signal,
    })
    if (res.status === 404) throw new Error('dev-прокси не отвечает — перезапусти pnpm dev')
    if (!res.ok) {
      throw new Error(await responseError(res, `gateway apply failed (${res.status})`))
    }
    return parseGatewayRuntime(await res.json())
  } finally {
    request.cleanup()
  }
}

export async function fetchGatewayRuntime(signal?: AbortSignal) {
  const request = createRequestSignal(signal)
  try {
    const res = await fetch('/__mes/gateway', {
      headers: runtimeClientHeaders(),
      signal: request.signal,
    })
    if (res.status === 204) return null
    if (!res.ok) return null
    return parseGatewayRuntime(await res.json())
  } finally {
    request.cleanup()
  }
}

function parseGatewayRuntime(value: unknown): GatewayRuntimeInfo {
  const runtime = expectRecord(value, 'gateway runtime')
  return {
    origin: expectString(runtime.origin, 'gateway runtime.origin'),
    host: expectString(runtime.host, 'gateway runtime.host'),
    tokenSet: expectBoolean(runtime.tokenSet, 'gateway runtime.tokenSet'),
    usingDefault: expectBoolean(runtime.usingDefault, 'gateway runtime.usingDefault'),
  }
}

async function responseError(response: Response, fallback: string) {
  const text = await response.text()
  if (!text) return fallback
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const message = (value as Record<string, unknown>).error
      if (typeof message === 'string' && message) return message
    }
  } catch {
    /* Preserve a plain-text control-plane error. */
  }
  return text
}
