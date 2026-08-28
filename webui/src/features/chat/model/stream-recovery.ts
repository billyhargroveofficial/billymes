import type { GatewayEvent } from '@/features/gateway'

/** Per-live-session watermarks make replay and concurrently delivered frames exact-once. */
export function acceptGatewayEvent(watermarks: Map<string, number>, event: GatewayEvent): boolean {
  if (!event.session_id || event.seq == null || !Number.isSafeInteger(event.seq)) return true
  const seen = watermarks.get(event.session_id) ?? 0
  if (event.seq <= seen) return false
  watermarks.set(event.session_id, event.seq)
  return true
}

export function replayEpochChanged(current: string | null, next: string | null) {
  return Boolean(current && next && current !== next)
}
