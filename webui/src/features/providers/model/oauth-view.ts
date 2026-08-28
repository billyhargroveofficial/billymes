import type { ExpiryValue, OauthFlow, OauthProvider, OauthSession } from './types'

/** Poll statuses that mean the background worker will not change anything else. */
const TERMINAL = new Set(['approved', 'error', 'expired', 'cancelled', 'denied'])

export function isTerminalOauthStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL.has(status)
}

export function oauthStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'approved':
      return 'подключено'
    case 'error':
      return 'ошибка входа'
    case 'expired':
      return 'код истёк'
    case 'cancelled':
      return 'отменено'
    case 'denied':
      return 'отказано'
    case 'pending':
    case null:
    case undefined:
      return 'ждём подтверждения'
    default:
      return status
  }
}

/**
 * Normalises the two shapes the gateway uses for expiry — an ISO timestamp or
 * epoch milliseconds — into milliseconds, or null when it is unusable.
 */
export function expiryMillis(value: ExpiryValue): number | null {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    // Seconds-since-epoch would land in 1970 when read as milliseconds.
    return value < 1e12 ? value * 1000 : value
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Laconic Russian relative expiry, e.g. «истекает через 3 ч». */
export function expiryLabel(value: ExpiryValue, now: number): string | null {
  const at = expiryMillis(value)
  if (at == null) return null
  const left = at - now
  if (left <= 0) return 'срок истёк'
  if (left < HOUR) return `истекает через ${Math.max(1, Math.round(left / MINUTE))} мин`
  if (left < DAY) return `истекает через ${Math.round(left / HOUR)} ч`
  return `истекает через ${Math.round(left / DAY)} дн`
}

export function flowLabel(flow: OauthFlow): string {
  switch (flow) {
    case 'pkce':
      return 'pkce'
    case 'device_code':
      return 'код устройства'
    default:
      return 'внешний cli'
  }
}

export function connectedCount(providers: readonly OauthProvider[]): number {
  return providers.reduce((total, provider) => total + (provider.status.loggedIn ? 1 : 0), 0)
}

/** Everything the row needs to describe a connection, already flattened. */
export function connectionSummary(provider: OauthProvider, now: number): string[] {
  const status = provider.status
  if (!status.loggedIn) return []
  const parts: string[] = []
  if (status.sourceLabel) parts.push(status.sourceLabel)
  else if (status.source) parts.push(status.source)
  if (status.tokenPreview) parts.push(status.tokenPreview)
  const expiry = expiryLabel(status.expiresAt, now)
  if (expiry) parts.push(expiry)
  if (status.hasRefreshToken) parts.push('есть refresh')
  return parts
}

/** Poll cadence in ms — the gateway's hint, clamped to a sane window. */
export function pollIntervalMs(session: OauthSession | null): number {
  const hint = session?.pollInterval
  if (hint == null || !Number.isFinite(hint)) return 2000
  return Math.min(15_000, Math.max(2000, Math.round(hint * 1000)))
}
