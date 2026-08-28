import { expectRecord } from '@/shared/api'
import type { ResourceUsage, SessionStats, SystemStats } from '../model/types'
import { booleanOr, nullableNumber, numberOr, stringOr } from './parse-usage'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function parseSessionStats(payload: unknown): SessionStats {
  const root = expectRecord(payload, 'sessions stats')
  const bySource = record(root.by_source)
  return {
    total: numberOr(root.total),
    activeStore: numberOr(root.active_store),
    archived: numberOr(root.archived),
    messages: numberOr(root.messages),
    bySource: Object.entries(bySource)
      .map(([source, count]) => ({ source, count: numberOr(count) }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count),
  }
}

function parseResource(value: unknown, freeKey: 'available' | 'free'): ResourceUsage | null {
  const row = record(value)
  const total = numberOr(row.total)
  if (total <= 0) return null
  const used = numberOr(row.used)
  const free = numberOr(row[freeKey], Math.max(0, total - used))
  const percent = nullableNumber(row.percent) ?? (total > 0 ? (used / total) * 100 : 0)
  return { total, used, free, percent }
}

/**
 * `/api/system/stats` degrades when psutil is missing: memory, disk, load and
 * process blocks disappear rather than turning into zeroes, so every optional
 * block parses to `null` and the UI hides it.
 */
export function parseSystemStats(payload: unknown): SystemStats {
  const root = expectRecord(payload, 'system stats')
  const process = record(root.process)
  const load = Array.isArray(root.load_avg) ? root.load_avg.map((value) => numberOr(value)) : []
  return {
    os: stringOr(root.os),
    osRelease: stringOr(root.os_release),
    arch: stringOr(root.arch),
    hostname: stringOr(root.hostname),
    pythonVersion: stringOr(root.python_version),
    hermesVersion: stringOr(root.hermes_version),
    cpuCount: nullableNumber(root.cpu_count),
    cpuPercent: nullableNumber(root.cpu_percent),
    loadAvg: load,
    memory: parseResource(root.memory, 'available'),
    disk: parseResource(root.disk, 'free'),
    uptimeSeconds: nullableNumber(root.uptime_seconds),
    processRss: nullableNumber(process.rss),
    processThreads: nullableNumber(process.num_threads),
    psutil: booleanOr(root.psutil, true),
  }
}
