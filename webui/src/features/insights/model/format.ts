/**
 * Number and time formatting for the analytics surfaces.
 *
 * The desk is Russian and every figure sits in a column, so numbers are
 * compacted with Russian magnitude words and a comma decimal separator, while
 * money keeps its dollar formatting because the gateway reports USD.
 */

const NBSP = ' '

const MAGNITUDES = [
  { limit: 1e6, divisor: 1e3, unit: 'тыс' },
  { limit: 1e9, divisor: 1e6, unit: 'млн' },
  { limit: Number.POSITIVE_INFINITY, divisor: 1e9, unit: 'млрд' },
] as const

/** Russian plural pick: 1 день / 2 дня / 5 дней. */
export function pluralRu(count: number, forms: readonly [string, string, string]): string {
  const absolute = Math.abs(Math.trunc(count))
  const mod100 = absolute % 100
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  const mod10 = absolute % 10
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

/** Groups thousands with a non-breaking space: 8157 → "8 157". */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** Compact magnitude form: 1200000 → "1,2 млн", 430000 → "430 тыс". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute < 1000) return formatInt(value)
  const scale = MAGNITUDES.find((entry) => absolute < entry.limit) ?? MAGNITUDES[2]
  const scaled = value / scale.divisor
  const digits = Math.abs(scaled) < 10 ? 1 : 0
  return `${decimal(scaled, digits)}${NBSP}${scale.unit}`
}

/** USD as the gateway reports it: "$0.42", "$1 204", "<$0.01". */
export function formatMoney(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  const absolute = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (absolute < 0.01) return `${sign}<$0.01`
  if (absolute < 1000) return `${sign}$${absolute.toFixed(2)}`
  return `${sign}$${formatInt(absolute)}`
}

export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return `${decimal(value, Math.abs(value) >= 10 ? 0 : digits)}%`
}

/** Binary sizes for the host strip: 101138505728 → "94,2 ГБ". */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] as const
  let scaled = value
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  const unit = units[index] ?? 'Б'
  return `${decimal(scaled, index === 0 || scaled >= 100 ? 0 : 1)}${NBSP}${unit}`
}

/** Coarse duration for uptime: 1762727 → "20 дн 9 ч". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}${NBSP}дн ${hours}${NBSP}ч`
  if (hours > 0) return `${hours}${NBSP}ч ${minutes}${NBSP}мин`
  return `${Math.max(1, minutes)}${NBSP}мин`
}

const MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const

/** "2026-08-26" → "26 авг". Unparseable input is echoed back unchanged. */
export function formatDayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return day
  const month = MONTHS[Number(match[2]) - 1]
  if (!month) return day
  return `${Number(match[3])}${NBSP}${month}`
}

/** Relative past time in Russian; `nowMs` is injected so it stays testable. */
export function formatRelativeTime(unixSeconds: number | null, nowMs: number): string {
  if (unixSeconds == null || !Number.isFinite(unixSeconds) || unixSeconds <= 0)
    return 'не использовалась'
  const elapsed = Math.max(0, Math.round(nowMs / 1000 - unixSeconds))
  if (elapsed < 90) return 'только что'
  const minutes = Math.round(elapsed / 60)
  if (minutes < 60)
    return `${minutes}${NBSP}${pluralRu(minutes, ['минута', 'минуты', 'минут'])} назад`
  const hours = Math.round(elapsed / 3600)
  if (hours < 24) return `${hours}${NBSP}${pluralRu(hours, ['час', 'часа', 'часов'])} назад`
  const days = Math.round(elapsed / 86400)
  if (days < 31) return `${days}${NBSP}${pluralRu(days, ['день', 'дня', 'дней'])} назад`
  const months = Math.round(days / 30)
  if (months < 12)
    return `${months}${NBSP}${pluralRu(months, ['месяц', 'месяца', 'месяцев'])} назад`
  const years = Math.round(days / 365)
  return `${years}${NBSP}${pluralRu(years, ['год', 'года', 'лет'])} назад`
}

function decimal(value: number, digits: number) {
  const fixed = value.toFixed(digits)
  const trimmed = digits > 0 ? fixed.replace(/\.0+$/, '') : fixed
  const [whole = '0', fraction] = trimmed.split('.')
  const grouped = formatInt(Number(whole))
  return fraction ? `${grouped},${fraction}` : grouped
}
