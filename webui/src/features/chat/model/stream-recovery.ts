import type { GatewayEvent } from '@/features/gateway'
import type { SessionEventsSinceResult } from './rpc-contracts'

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

type RecoveryLease = { token: number; sessionId: string; events: GatewayEvent[] }

/** Own buffered reconnect events by recovery token, not only session id. */
export class ReplayRecoveryBuffer {
  private nextToken = 0
  private active: RecoveryLease | null = null

  begin(sessionId: string) {
    const token = ++this.nextToken
    // A newer recovery supersedes its predecessor's ownership but inherits
    // same-session live frames, so starting B never discards A's tail.
    const events = this.active?.sessionId === sessionId ? this.active.events : []
    this.active = { token, sessionId, events }
    return token
  }

  accepts(sessionId: string) {
    return this.active?.sessionId === sessionId
  }

  push(event: GatewayEvent) {
    this.active?.events.push(event)
  }

  take(token: number) {
    if (this.active?.token !== token) return []
    const events = this.active.events
    this.active = null
    return events
  }
}

type DurableReplayRecoveryOptions = {
  initial: SessionEventsSinceResult
  lastSeen: number
  forceRefresh: boolean
  requestSince: (cursor: number) => Promise<SessionEventsSinceResult>
  refreshHistory: () => Promise<void>
}

/**
 * Align replay with a REST snapshot. Frames at or before `replay_base_seq`
 * are covered by REST or intentional supersession and must not be overlaid.
 * Re-read after each snapshot to retain a still-running tail. A bounded retry
 * budget fails closed rather than claiming a cursor REST has not covered.
 */
export const MAX_REPLAY_REFRESHES = 8
export async function recoverDurableReplay({
  initial,
  lastSeen,
  forceRefresh,
  requestSince,
  refreshHistory,
}: DurableReplayRecoveryOptions) {
  let replay = initial
  let cursor = lastSeen
  let refreshRequired = forceRefresh || replay.truncated || replay.replay_base_seq > cursor
  let refreshes = 0
  while (refreshRequired) {
    if (refreshes >= MAX_REPLAY_REFRESHES) {
      throw new Error('replay baseline did not stabilize')
    }
    await refreshHistory()
    cursor = Math.max(cursor, replay.replay_base_seq)
    replay = await requestSince(cursor)
    refreshes += 1
    if (replay.truncated) throw new Error('post-refresh replay is truncated')
    // A newer baseline appeared while REST was being read. Repeat the
    // snapshot/read pair until both projections agree or the budget expires.
    refreshRequired = replay.replay_base_seq > cursor
  }
  return {
    cursor,
    latestSeq: replay.latest_seq,
    events: replay.events.filter((event) => event.seq == null || event.seq > cursor),
  }
}
