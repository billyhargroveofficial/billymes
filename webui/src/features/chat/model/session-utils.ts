import type { SessionInfo } from './types'

function sessionTime(s: SessionInfo) {
  const raw = s.last_activity_at || s.last_active || s.started_at || 0
  return raw > 1e12 ? raw / 1000 : raw
}

function dayStamp(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export type SessionGroup = { key: string; label: string; items: SessionInfo[] }

/**
 * The gateway lists only `message_count` (user + assistant messages, tools
 * excluded) — a turn is one exchange, so half the messages, rounded up.
 */
export function sessionTurns(messageCount: number): number {
  return Math.max(1, Math.ceil(messageCount / 2))
}

/** A stale session-list snapshot must not look like a running live turn. */
export function isSessionPlaying(sessionId: string, playingId: string | null) {
  return sessionId === playingId
}

/** Never delete the selected or currently-running runtime session in bulk. */
export function batchDeleteableSessionIds(
  selected: Iterable<string>,
  activeId: string | null,
  playingId: string | null,
) {
  return [...new Set(selected)].filter((id) => id !== activeId && id !== playingId)
}

export function groupSessions(sessions: SessionInfo[]): SessionGroup[] {
  const now = new Date()
  const today = dayStamp(now.getTime() / 1000)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  const yesterday = dayStamp(y.getTime() / 1000)

  const pinned: SessionInfo[] = []
  const buckets: Record<'today' | 'yesterday' | 'earlier', SessionInfo[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  }

  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a))
  for (const s of sorted) {
    if (s.pinned) {
      pinned.push(s)
      continue
    }
    const day = dayStamp(sessionTime(s) || 0)
    if (day === today) buckets.today.push(s)
    else if (day === yesterday) buckets.yesterday.push(s)
    else buckets.earlier.push(s)
  }

  const groups: SessionGroup[] = []
  if (pinned.length) groups.push({ key: 'pinned', label: 'закреплённые', items: pinned })
  if (buckets.today.length) groups.push({ key: 'today', label: 'сегодня', items: buckets.today })
  if (buckets.yesterday.length)
    groups.push({ key: 'yesterday', label: 'вчера', items: buckets.yesterday })
  if (buckets.earlier.length)
    groups.push({ key: 'earlier', label: 'ранее', items: buckets.earlier })
  return groups
}

export function estimateContext(
  s: {
    input_tokens?: number | null
    output_tokens?: number | null
    reasoning_tokens?: number | null
    context_used?: number | null
    context_max?: number | null
  },
  window = 272000,
) {
  if (s.context_used && s.context_used > 0) {
    return {
      used: s.context_used,
      max: s.context_max || window,
      pct: s.context_max
        ? Math.min(100, Math.round((s.context_used / s.context_max) * 100))
        : Math.min(100, Math.round((s.context_used / window) * 100)),
    }
  }
  const used = Math.min(window, (s.input_tokens || 0) + (s.reasoning_tokens || 0))
  return {
    used,
    max: window,
    pct: window ? Math.min(100, Math.round((used / window) * 100)) : 0,
  }
}

export function mergeUsage<T extends Record<string, unknown>>(prev: T, incoming: Partial<T>): T {
  const next = { ...prev }
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue
    if (typeof value === 'number' && value === 0) {
      const cur = next[key as keyof T]
      if (typeof cur === 'number' && cur > 0) continue
    }
    ;(next as Record<string, unknown>)[key] = value
  }
  return next
}
