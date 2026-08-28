import type { GatewayEvent } from '@/features/gateway'

export type SelectedSessions = {
  live: string | null
  history: string | null
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
