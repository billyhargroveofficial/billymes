import { describe, expect, it } from 'vitest'
import { ApiPayloadError } from '@/shared/api'
import { parseSessionStats, parseSystemStats } from './parse-host'

describe('parseSessionStats', () => {
  it('ranks the sources and drops empty ones', () => {
    const stats = parseSessionStats({
      total: 220,
      active_store: 220,
      archived: 0,
      messages: 33_817,
      by_source: { cli: 64, desktop: 52, telegram: 29, gone: 0 },
    })
    expect(stats.total).toBe(220)
    expect(stats.messages).toBe(33_817)
    expect(stats.bySource).toEqual([
      { source: 'cli', count: 64 },
      { source: 'desktop', count: 52 },
      { source: 'telegram', count: 29 },
    ])
  })

  it('survives a payload without a source breakdown', () => {
    expect(parseSessionStats({ total: 1 }).bySource).toEqual([])
  })

  it('rejects a non-object payload', () => {
    expect(() => parseSessionStats(null)).toThrow(ApiPayloadError)
  })
})

describe('parseSystemStats', () => {
  it('reads the full psutil payload', () => {
    const stats = parseSystemStats({
      os: 'Linux',
      os_release: '7.1.4-arch1-1',
      arch: 'x86_64',
      hostname: 'mujik',
      python_version: '3.11.15',
      hermes_version: '0.20.5',
      cpu_count: 32,
      cpu_percent: 0.3,
      load_avg: [1.6, 1.09, 1.12],
      memory: {
        total: 101_138_505_728,
        available: 80_747_978_752,
        used: 20_390_526_976,
        percent: 20.2,
      },
      disk: { total: 983_350_071_296, used: 211_885_010_944, free: 761_446_248_448, percent: 21.8 },
      uptime_seconds: 1_762_727,
      process: { pid: 3_268_872, rss: 1_213_521_920, num_threads: 99 },
      psutil: true,
    })
    expect(stats.hostname).toBe('mujik')
    expect(stats.hermesVersion).toBe('0.20.5')
    expect(stats.loadAvg).toEqual([1.6, 1.09, 1.12])
    expect(stats.memory?.percent).toBe(20.2)
    expect(stats.disk?.free).toBe(761_446_248_448)
    expect(stats.processThreads).toBe(99)
    expect(stats.psutil).toBe(true)
  })

  it('degrades to nulls when psutil is missing', () => {
    const stats = parseSystemStats({
      os: 'Linux',
      hostname: 'mujik',
      python_version: '3.11.15',
      psutil: false,
    })
    expect(stats.memory).toBeNull()
    expect(stats.disk).toBeNull()
    expect(stats.uptimeSeconds).toBeNull()
    expect(stats.processRss).toBeNull()
    expect(stats.loadAvg).toEqual([])
    expect(stats.psutil).toBe(false)
  })

  it('derives a percentage the host did not send', () => {
    const stats = parseSystemStats({ memory: { total: 200, used: 50 } })
    expect(stats.memory).toEqual({ total: 200, used: 50, free: 150, percent: 25 })
  })

  it('rejects a non-object payload', () => {
    expect(() => parseSystemStats('nope')).toThrow(ApiPayloadError)
  })
})
