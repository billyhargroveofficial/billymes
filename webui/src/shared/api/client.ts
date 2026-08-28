import { runtimeClientHeaders } from './runtime-client'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export class ApiPayloadError extends Error {
  constructor(label: string) {
    super(`Invalid API payload: ${label}`)
    this.name = 'ApiPayloadError'
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000

type RequestSignal = {
  signal: AbortSignal
  cleanup: () => void
}

export function createRequestSignal(
  parent: AbortSignal | null | undefined,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): RequestSignal {
  const controller = new AbortController()
  const duration = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : DEFAULT_HTTP_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let parentAbort: (() => void) | undefined

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    if (parent && parentAbort) parent.removeEventListener('abort', parentAbort)
    timer = undefined
    parentAbort = undefined
  }

  const abortFromParent = () => {
    controller.abort(parent?.reason)
    cleanup()
  }

  if (parent?.aborted) {
    abortFromParent()
    return { signal: controller.signal, cleanup }
  }

  if (parent) {
    parentAbort = abortFromParent
    parent.addEventListener('abort', parentAbort, { once: true })
  }
  timer = setTimeout(() => {
    const error = new Error(`request timed out after ${duration}ms`)
    error.name = 'TimeoutError'
    controller.abort(error)
    cleanup()
  }, duration)

  return { signal: controller.signal, cleanup }
}

export function withProfile(url: string, profile?: string) {
  if (!profile || profile === 'default' || url.includes('profile=')) return url
  return `${url}${url.includes('?') ? '&' : '?'}profile=${encodeURIComponent(profile)}`
}

export async function requestJson(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const headers = runtimeClientHeaders(init.headers)
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData
  if (init.body && !headers.has('Content-Type') && !isFormData) {
    headers.set('Content-Type', 'application/json')
  }

  const request = createRequestSignal(init.signal, options.timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      headers,
      credentials: 'include',
      signal: request.signal,
    })
    const text = await response.text()
    const data = text ? safeJson(text) : null
    if (!response.ok) {
      throw new ApiError(response.status, errorMessage(data, response.status), data)
    }
    return data
  } finally {
    request.cleanup()
  }
}

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiPayloadError(label)
  }
  return value as Record<string, unknown>
}

export function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ApiPayloadError(label)
  return value
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ApiPayloadError(label)
  return value
}

export function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ApiPayloadError(label)
  return value
}

export function optionalString(value: unknown, label: string): string | null {
  if (value == null) return null
  return expectString(value, label)
}

export function optionalNumber(value: unknown, label: string): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiPayloadError(label)
  return value
}

function errorMessage(data: unknown, status: number) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>
    if (typeof record.detail === 'string') return record.detail
    if (typeof record.error === 'string') return record.error
    if (typeof record.message === 'string') return record.message
  }
  return `HTTP ${status}`
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
