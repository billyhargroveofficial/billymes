import { describe, expect, it } from 'vitest'
import { accountUsageChips, resetLabel } from './account-usage-view'
import type { AccountUsage } from './types'

const ACCOUNTS: AccountUsage[] = [
  {
    provider: 'openai-codex',
    plan: 'Pro',
    windows: [
      { label: 'Session', usedPercent: 13, resetAt: '2026-09-03T16:27:41+00:00', detail: null },
    ],
    details: ['You have 1 reset banked - use /usage reset to activate'],
  },
  {
    provider: 'anthropic',
    plan: null,
    windows: [
      { label: 'Current session', usedPercent: 42.4, resetAt: null, detail: null },
      { label: 'Current week', usedPercent: 3, resetAt: null, detail: null },
    ],
    details: [],
  },
]

describe('accountUsageChips', () => {
  it('renders one chip per account with russian window names', () => {
    const chips = accountUsageChips(ACCOUNTS)
    expect(chips.map((chip) => [chip.key, chip.name, chip.plan, chip.summary])).toEqual([
      ['openai-codex', 'codex', 'Pro', '13% сессия'],
      ['anthropic', 'claude', null, '42% сессия · 3% неделя'],
    ])
  })

  it('collects reset moments and provider notes into the tooltip', () => {
    const chips = accountUsageChips(ACCOUNTS)
    expect(chips[0]?.tooltip).toMatch(/^сессия — 13%, сброс \d{2}\.\d{2} \d{2}:\d{2}\n/)
    expect(chips[0]?.tooltip).toContain('reset banked')
    expect(chips[1]?.tooltip).toBe('сессия — 42%\nнеделя — 3%')
  })

  it('warns at 80% and drops accounts without metered windows', () => {
    const noisy: AccountUsage[] = [
      {
        provider: 'anthropic',
        plan: null,
        windows: [{ label: 'Current session', usedPercent: 81, resetAt: null, detail: null }],
        details: [],
      },
      { provider: 'openrouter', plan: null, windows: [], details: ['Credits: $5'] },
    ]
    const chips = accountUsageChips(noisy)
    expect(chips).toHaveLength(1)
    expect(chips[0]?.warn).toBe(true)
  })
})

describe('resetLabel', () => {
  it('formats parsable timestamps and rejects the rest', () => {
    expect(resetLabel('2026-09-03T16:27:41+00:00')).toMatch(/^сброс \d{2}\.\d{2} \d{2}:\d{2}$/)
    expect(resetLabel('not-a-date')).toBeNull()
    expect(resetLabel(null)).toBeNull()
  })
})
