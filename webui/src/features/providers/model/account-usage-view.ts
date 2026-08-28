import type { AccountUsage } from './types'

/** One header chip: a connected subscription and how much of it is spent. */
export type AccountUsageChip = {
  key: string
  name: string
  plan: string | null
  /** «43% сессия · 3% неделя» — one part per metered window. */
  summary: string
  /** Multi-line hover text with reset moments and provider notes. */
  tooltip: string
  /** True once any window is at least 80% spent. */
  warn: boolean
}

const PROVIDER_NAMES: Record<string, string> = {
  'openai-codex': 'codex',
  anthropic: 'claude',
  openrouter: 'openrouter',
}

const WINDOW_NAMES: Record<string, string> = {
  session: 'сессия',
  'current session': 'сессия',
  weekly: 'неделя',
  'current week': 'неделя',
}

const WARN_THRESHOLD = 80

function windowName(label: string): string {
  return WINDOW_NAMES[label.trim().toLowerCase()] ?? label.trim().toLowerCase()
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local-time «сброс 03.09 19:27»; null for unparsable timestamps. */
export function resetLabel(resetAt: string | null): string | null {
  if (!resetAt) return null
  const at = new Date(resetAt)
  if (Number.isNaN(at.getTime())) return null
  return `сброс ${pad(at.getDate())}.${pad(at.getMonth() + 1)} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function accountUsageChips(accounts: readonly AccountUsage[]): AccountUsageChip[] {
  const chips: AccountUsageChip[] = []
  for (const account of accounts) {
    const metered = account.windows.filter((window) => window.usedPercent != null)
    if (metered.length === 0) continue
    const tooltipLines = metered.map((window) => {
      const percent = Math.round(window.usedPercent ?? 0)
      const reset = resetLabel(window.resetAt)
      return [`${windowName(window.label)} — ${percent}%`, reset, window.detail]
        .filter(Boolean)
        .join(', ')
    })
    chips.push({
      key: account.provider,
      name: PROVIDER_NAMES[account.provider] ?? account.provider,
      plan: account.plan,
      summary: metered
        .map((window) => `${Math.round(window.usedPercent ?? 0)}% ${windowName(window.label)}`)
        .join(' · '),
      tooltip: [...tooltipLines, ...account.details].join('\n'),
      warn: metered.some((window) => (window.usedPercent ?? 0) >= WARN_THRESHOLD),
    })
  }
  return chips
}
