import { describe, expect, it } from 'vitest'
import {
  activeDays,
  dayToMs,
  emptyDay,
  fillDailyGaps,
  isoDay,
  peakIndex,
  perDay,
  rankBy,
  sumBy,
  topWithTail,
} from './aggregate'
import type { DailyUsage } from './types'

function day(date: string, apiCalls: number): DailyUsage {
  return { ...emptyDay(date), apiCalls, inputTokens: apiCalls * 10 }
}

const NOW = Date.UTC(2026, 7, 8, 11, 30)

describe('isoDay / dayToMs', () => {
  it('round-trips a UTC day', () => {
    expect(isoDay(NOW)).toBe('2026-08-08')
    expect(dayToMs('2026-08-08')).toBe(Date.UTC(2026, 7, 8))
  })

  it('rejects a malformed day', () => {
    expect(dayToMs('08.08.2026')).toBeNull()
  })
})

describe('fillDailyGaps', () => {
  it('produces a continuous window ending today', () => {
    const filled = fillDailyGaps([day('2026-08-05', 12)], 7, NOW)
    expect(filled).toHaveLength(7)
    expect(filled.map((row) => row.day)).toEqual([
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ])
    expect(filled[3]?.apiCalls).toBe(12)
    expect(filled[0]?.apiCalls).toBe(0)
    expect(filled[0]?.cacheReadTokens).toBe(0)
  })

  it('never drops a reported day that falls outside the window', () => {
    const filled = fillDailyGaps([day('2026-08-01', 3), day('2026-08-08', 4)], 3, NOW)
    expect(filled).toHaveLength(8)
    expect(filled[0]?.day).toBe('2026-08-01')
    expect(filled.at(-1)?.day).toBe('2026-08-08')
  })

  it('extends past today when the gateway reports a newer day', () => {
    const filled = fillDailyGaps([day('2026-08-09', 5)], 2, NOW)
    expect(filled.at(-1)?.day).toBe('2026-08-09')
  })

  it('still returns a window with no data at all', () => {
    const filled = fillDailyGaps([], 7, NOW)
    expect(filled).toHaveLength(7)
    expect(filled.every((row) => row.apiCalls === 0)).toBe(true)
  })

  it('ignores unparseable days', () => {
    const filled = fillDailyGaps([{ ...emptyDay('вчера'), apiCalls: 9 }], 3, NOW)
    expect(filled).toHaveLength(3)
    expect(sumBy(filled, (row) => row.apiCalls)).toBe(0)
  })
})

describe('activeDays', () => {
  it('counts days that saw traffic', () => {
    expect(activeDays(fillDailyGaps([day('2026-08-05', 12)], 7, NOW))).toBe(1)
  })
})

describe('sumBy', () => {
  it('skips non-finite values', () => {
    expect(sumBy([1, Number.NaN, 3], (value) => value)).toBe(4)
  })
})

describe('rankBy', () => {
  it('sorts descending and drops empty rows', () => {
    const rows = [
      { name: 'a', count: 1 },
      { name: 'b', count: 9 },
      { name: 'c', count: 0 },
    ]
    expect(rankBy(rows, (row) => row.count).map((row) => row.name)).toEqual(['b', 'a'])
  })

  it('does not mutate the input', () => {
    const rows = [{ count: 1 }, { count: 2 }]
    rankBy(rows, (row) => row.count)
    expect(rows[0]?.count).toBe(1)
  })
})

describe('topWithTail', () => {
  const rows = [1, 2, 3, 4, 5]

  it('folds the tail away', () => {
    expect(topWithTail(rows, 3, false)).toEqual({ head: [1, 2, 3], hidden: 2 })
  })

  it('shows everything when expanded', () => {
    expect(topWithTail(rows, 3, true)).toEqual({ head: rows, hidden: 0 })
  })

  it('reports no tail for a short list', () => {
    expect(topWithTail(rows, 9, false)).toEqual({ head: rows, hidden: 0 })
  })
})

describe('perDay', () => {
  it('averages over the window', () => {
    expect(perDay(300, 30)).toBe(10)
  })

  it('guards a zero window', () => {
    expect(perDay(300, 0)).toBe(0)
  })
})

describe('peakIndex', () => {
  it('returns the first index of the highest value', () => {
    expect(peakIndex([1, 9, 3, 9])).toBe(1)
  })

  it('ignores a window with nothing above zero', () => {
    expect(peakIndex([0, 0, Number.NaN])).toBeNull()
    expect(peakIndex([])).toBeNull()
  })
})
