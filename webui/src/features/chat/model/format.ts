export function fmtTokens(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
}

/** Gateway rows carry epoch seconds, live events sometimes milliseconds. */
function toSeconds(ts: number) {
  return ts > 1e12 ? ts / 1000 : ts
}

export function fmtClock(ts?: number) {
  if (!ts) return ''
  const d = new Date(toSeconds(ts) * 1000)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayStamp(d: Date) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** «сегодня» / «вчера» / «14 августа» — separator labels inside the thread. */
export function dayLabel(ts?: number) {
  if (!ts) return ''
  const date = new Date(toSeconds(ts) * 1000)
  const now = new Date()
  if (dayStamp(date) === dayStamp(now)) return 'сегодня'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayStamp(date) === dayStamp(yesterday)) return 'вчера'
  const label = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`
}

/** Compact «только что / 5м / 3ч / вчера / 12.08» for session rows. */
export function relTime(ts?: number | null) {
  if (!ts) return ''
  const sec = toSeconds(ts)
  const diff = Date.now() / 1000 - sec
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)}м`
  if (diff < 86_400) return `${Math.floor(diff / 3600)}ч`
  const date = new Date(sec * 1000)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayStamp(date) === dayStamp(yesterday)) return 'вчера'
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}
