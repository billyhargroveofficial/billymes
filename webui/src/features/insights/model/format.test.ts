import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatCompact,
  formatDayLabel,
  formatDuration,
  formatInt,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  pluralRu,
} from './format'

const NBSP = ' '

describe('pluralRu', () => {
  const days = ['день', 'дня', 'дней'] as const

  it('picks the Russian form', () => {
    expect(pluralRu(1, days)).toBe('день')
    expect(pluralRu(2, days)).toBe('дня')
    expect(pluralRu(5, days)).toBe('дней')
    expect(pluralRu(11, days)).toBe('дней')
    expect(pluralRu(21, days)).toBe('день')
    expect(pluralRu(112, days)).toBe('дней')
  })
})

describe('formatInt', () => {
  it('groups thousands', () => {
    expect(formatInt(8157)).toBe(`8${NBSP}157`)
    expect(formatInt(999)).toBe('999')
    expect(formatInt(1_234_567)).toBe(`1${NBSP}234${NBSP}567`)
  })

  it('marks a non-number', () => {
    expect(formatInt(Number.NaN)).toBe('—')
  })
})

describe('formatCompact', () => {
  it('uses Russian magnitudes with a comma separator', () => {
    expect(formatCompact(1_200_000)).toBe(`1,2${NBSP}млн`)
    expect(formatCompact(430_000)).toBe(`430${NBSP}тыс`)
    expect(formatCompact(966_552_995)).toBe(`967${NBSP}млн`)
    expect(formatCompact(1_500_000_000)).toBe(`1,5${NBSP}млрд`)
  })

  it('drops a trailing zero decimal', () => {
    expect(formatCompact(1_000_000)).toBe(`1${NBSP}млн`)
  })

  it('leaves small numbers alone', () => {
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(0)).toBe('0')
  })
})

describe('formatMoney', () => {
  it('keeps two decimals below a thousand', () => {
    expect(formatMoney(0.41895)).toBe('$0.42')
    expect(formatMoney(1.2046)).toBe('$1.20')
  })

  it('has explicit zero and sub-cent forms', () => {
    expect(formatMoney(0)).toBe('$0')
    expect(formatMoney(0.004)).toBe('<$0.01')
  })

  it('groups large amounts', () => {
    expect(formatMoney(1204)).toBe(`$1${NBSP}204`)
  })
})

describe('formatPercent', () => {
  it('drops the decimal above ten percent', () => {
    expect(formatPercent(19.166)).toBe('19%')
    expect(formatPercent(4.138)).toBe('4,1%')
  })
})

describe('formatBytes', () => {
  it('scales to binary units', () => {
    expect(formatBytes(101_138_505_728)).toBe(`94,2${NBSP}ГБ`)
    expect(formatBytes(512)).toBe(`512${NBSP}Б`)
  })

  it('marks an unknown size', () => {
    expect(formatBytes(0)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('shows days and hours for a long uptime', () => {
    expect(formatDuration(1_762_727)).toBe(`20${NBSP}дн 9${NBSP}ч`)
  })

  it('falls back to hours and minutes', () => {
    expect(formatDuration(3700)).toBe(`1${NBSP}ч 1${NBSP}мин`)
    expect(formatDuration(45)).toBe(`1${NBSP}мин`)
  })
})

describe('formatDayLabel', () => {
  it('renders a short Russian day', () => {
    expect(formatDayLabel('2026-08-26')).toBe(`26${NBSP}авг`)
    expect(formatDayLabel('2026-01-01')).toBe(`1${NBSP}янв`)
  })

  it('echoes an unparseable value', () => {
    expect(formatDayLabel('вчера')).toBe('вчера')
  })
})

describe('formatRelativeTime', () => {
  const now = 1_787_765_216_000

  it('reads back in Russian', () => {
    expect(formatRelativeTime(now / 1000 - 30, now)).toBe('только что')
    expect(formatRelativeTime(now / 1000 - 600, now)).toBe(`10${NBSP}минут назад`)
    expect(formatRelativeTime(1_787_757_421.97, now)).toBe(`2${NBSP}часа назад`)
    expect(formatRelativeTime(now / 1000 - 86_400, now)).toBe(`1${NBSP}день назад`)
    expect(formatRelativeTime(now / 1000 - 5 * 86_400, now)).toBe(`5${NBSP}дней назад`)
    expect(formatRelativeTime(now / 1000 - 90 * 86_400, now)).toBe(`3${NBSP}месяца назад`)
    expect(formatRelativeTime(now / 1000 - 800 * 86_400, now)).toBe(`2${NBSP}года назад`)
  })

  it('handles a model that was never used', () => {
    expect(formatRelativeTime(null, now)).toBe('не использовалась')
    expect(formatRelativeTime(0, now)).toBe('не использовалась')
  })
})
