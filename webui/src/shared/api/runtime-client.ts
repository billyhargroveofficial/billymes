export const RUNTIME_CLIENT_HEADER = 'X-Mes-Runtime'
export const RUNTIME_CLIENT_QUERY = '__mes_runtime'
const MIN_RUNTIME_CLIENT_ID_LENGTH = 16
const MAX_RUNTIME_CLIENT_ID_LENGTH = 128

const GLOBAL_RUNTIME_ID = '__mesRuntimeClientId__'
type RuntimeHeadersInit = ConstructorParameters<typeof Headers>[0]

type RuntimeGlobal = typeof globalThis & {
  [GLOBAL_RUNTIME_ID]?: string
}

export function runtimeClientId() {
  const target = globalThis as RuntimeGlobal
  if (target[GLOBAL_RUNTIME_ID]) return target[GLOBAL_RUNTIME_ID]
  const id = createRuntimeClientId()
  target[GLOBAL_RUNTIME_ID] = id
  return id
}

export function runtimeClientHeaders(headers?: RuntimeHeadersInit, id = runtimeClientId()) {
  const next = new Headers(headers)
  next.set(RUNTIME_CLIENT_HEADER, id)
  return next
}

/**
 * Runtime IDs are opaque browser-realm identities, not user input. Keep the
 * accepted alphabet deliberately small so they are safe in headers and query
 * strings, and require enough material to make accidental collisions unlikely.
 */
export function isRuntimeClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_RUNTIME_CLIENT_ID_LENGTH &&
    value.length <= MAX_RUNTIME_CLIENT_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value) &&
    new Set(value).size >= 4
  )
}

export function appendRuntimeClient(url: string, id = runtimeClientId()) {
  const absolute = /^[a-z][a-z\d+.-]*:\/\//iu.test(url)
  const parsed = new URL(url, 'http://mes.invalid')
  parsed.searchParams.set(RUNTIME_CLIENT_QUERY, id)
  return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function createRuntimeClientId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return `mes-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
  }
  throw new Error('secure randomness is required for the gateway runtime identity')
}
