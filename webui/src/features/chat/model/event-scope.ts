import type { GatewayEvent } from '@/features/gateway'

export type SelectedSessions = {
  live: string | null
  history: string | null
}

/**
 * Compression rotates the durable SQLite identity while the live gateway id
 * stays fixed. Accept that rebind only from the currently selected live
 * session and only across the exact previous durable id, so delayed events
 * from another lineage cannot move the open chat.
 */
export function sessionIdentityFromEvent(
  event: GatewayEvent,
  selected: SelectedSessions,
): SelectedSessions | null {
  if (
    event.type !== 'session.identity' ||
    !event.session_id ||
    event.session_id !== selected.live
  ) {
    return null
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
    return null
  const payload = event.payload as Record<string, unknown>
  const storedSessionId =
    typeof payload.stored_session_id === 'string' ? payload.stored_session_id.trim() : ''
  const previousStoredSessionId =
    typeof payload.previous_stored_session_id === 'string'
      ? payload.previous_stored_session_id.trim()
      : ''
  if (!storedSessionId || !previousStoredSessionId) return null
  if (selected.history === storedSessionId) return selected
  if (selected.history !== previousStoredSessionId) return null
  return { live: selected.live, history: storedSessionId }
}

/**
 * Events in this list are deliberately not tied to a session. Keep this
 * allowlist exact: an unscoped event must never be allowed to mutate chat
 * state merely because its name is unfamiliar.
 */
const GLOBAL_EVENT_TYPES = ['gateway.status'] as const

const globalEventTypes: ReadonlySet<string> = new Set(GLOBAL_EVENT_TYPES)

export function eventBelongsToSelection(
  event: GatewayEvent,
  profile: string,
  selected: SelectedSessions,
) {
  if (
    event.profile &&
    event.profile !== profile &&
    !(profile === 'default' && event.profile === '')
  ) {
    return false
  }
  if (
    event.session_id &&
    event.session_id !== selected.live &&
    event.session_id !== selected.history
  ) {
    return false
  }
  if (globalEventTypes.has(event.type)) return true
  return Boolean(event.session_id)
}
