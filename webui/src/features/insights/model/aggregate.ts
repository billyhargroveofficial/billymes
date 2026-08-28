import type { DailyUsage } from './types'

/**
 * Derivations shared by the analytics sections.
 *
 * The gateway's `daily` array is sparse — a day with no activity is simply
 * missing — so every chart here runs on a gap-filled, continuous window.
 */

const DAY_MS = 86_400_000
const MAX_WINDOW = 400

export function emptyDay(day: string): DailyUsage {
  return {
    day,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    estimatedCost: 0,
    actualCost: 0,
    sessions: 0,
    apiCalls: 0,
  }
}

/** "2026-08-26" for the UTC day containing `ms`. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Milliseconds at midnight UTC of an ISO day, or `null` when unparseable. */
export function dayToMs(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isFinite(ms) ? ms : null
}

/**
 * Continuous day window ending today (or on the newest reported day, whichever
 * is later) and covering at least `days` days plus every reported day.
 */
export function fillDailyGaps(
  rows: readonly DailyUsage[],
  days: number,
  nowMs: number,
): DailyUsage[] {
  const known = new Map<string, DailyUsage>()
  const stamps: number[] = []
  for (const row of rows) {
    const ms = dayToMs(row.day)
    if (ms == null) continue
    known.set(row.day, row)
    stamps.push(ms)
  }

  const span = Number.isFinite(days) ? Math.max(1, Math.round(days)) : 1
  const todayMs = dayToMs(isoDay(nowMs)) ?? 0
  const endMs = Math.max(todayMs, ...(stamps.length ? [Math.max(...stamps)] : []))
  const fromWindow = endMs - (span - 1) * DAY_MS
  const startMs = Math.min(fromWindow, ...(stamps.length ? [Math.min(...stamps)] : []))
  const length = Math.min(MAX_WINDOW, Math.floor((endMs - startMs) / DAY_MS) + 1)

  return Array.from({ length }, (_, index) => {
    const day = isoDay(endMs - (length - 1 - index) * DAY_MS)
    return known.get(day) ?? emptyDay(day)
  })
}

/** Days in the window that actually saw traffic. */
export function activeDays(rows: readonly DailyUsage[]): number {
  return rows.filter((row) => row.apiCalls > 0 || row.inputTokens > 0).length
}

export function sumBy<T>(rows: readonly T[], value: (row: T) => number): number {
  return rows.reduce((total, row) => {
    const next = value(row)
    return total + (Number.isFinite(next) ? next : 0)
  }, 0)
}

/** Descending rank by a numeric field, dropping rows with nothing to show. */
export function rankBy<T>(rows: readonly T[], value: (row: T) => number): T[] {
  return rows
    .filter((row) => {
      const next = value(row)
      return Number.isFinite(next) && next > 0
    })
    .slice()
    .sort((left, right) => value(right) - value(left))
}

/** Head of a ranked list plus how much long tail is being withheld. */
export function topWithTail<T>(
  rows: readonly T[],
  limit: number,
  expanded: boolean,
): { head: T[]; hidden: number } {
  if (expanded || rows.length <= limit) return { head: rows.slice(), hidden: 0 }
  return { head: rows.slice(0, limit), hidden: rows.length - limit }
}

/** Per-day average over the requested window, guarding a zero-length window. */
export function perDay(total: number, days: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(days) || days <= 0) return 0
  return total / days
}

/** Index of the highest finite value, or `null` when nothing is above zero. */
export function peakIndex(values: readonly number[]): number | null {
  let best = 0
  let max = Number.NEGATIVE_INFINITY
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (typeof value === 'number' && Number.isFinite(value) && value > max) {
      max = value
      best = index
    }
  }
  return max > 0 ? best : null
}
