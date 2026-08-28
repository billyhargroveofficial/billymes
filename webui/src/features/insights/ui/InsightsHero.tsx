import { memo, useMemo } from 'react'
import { EmptyHint } from '@/shared/ui/page'
import { Skeleton } from '@/shared/ui/skeleton'
import { Notice } from '@/shared/ui/notice'
import { SwapPane } from '@/shared/ui/motion'
import { perDay } from '../model/aggregate'
import { formatCompact, formatDayLabel, formatInt, formatMoney, pluralRu } from '../model/format'
import type { DailyUsage, UsageTotals } from '../model/types'
import { AreaTrend } from './charts/AreaTrend'
import { DAILY_COLORS } from './charts/palette'
import { paneFor } from './pane'

const CALL_FORMS = ['вызов', 'вызова', 'вызовов'] as const

/**
 * Masthead of `/insights`: the window's cost, one line of facts, and the
 * calls pulse. Hovering a day retargets the figures; there is no second chart.
 */
export const InsightsHero = memo(function InsightsHero({
  totals,
  daily,
  days,
  pending,
  error,
  cursor,
  onCursor,
}: {
  totals: UsageTotals | null
  daily: readonly DailyUsage[]
  days: number
  pending: boolean
  error: string | null
  cursor: number | null
  onCursor: (index: number | null) => void
}) {
  const empty = !totals || (totals.apiCalls === 0 && totals.input === 0)
  const pane = paneFor(pending, error, empty)
  const inspected = cursor != null ? (daily[cursor] ?? null) : null

  const dayAxis = useMemo(() => daily.map((row) => row.day), [daily])
  const calls = useMemo(() => daily.map((row) => row.apiCalls), [daily])
  const callSeries = useMemo(
    () => [
      {
        key: 'calls',
        label: 'вызовы',
        color: DAILY_COLORS.calls,
        values: calls,
      },
    ],
    [calls],
  )
  const chartKey = `${days}:${daily[0]?.day ?? ''}`

  const callCount = inspected ? inspected.apiCalls : (totals?.apiCalls ?? 0)
  const sessions = inspected ? inspected.sessions : (totals?.sessions ?? 0)
  const input = inspected ? inspected.inputTokens : (totals?.input ?? 0)
  const output = inspected ? inspected.outputTokens : (totals?.output ?? 0)

  const facts =
    pane === 'ready' && totals
      ? [
          `${formatInt(callCount)} ${pluralRu(callCount, CALL_FORMS)}`,
          `${formatInt(sessions)} сессий`,
          `${formatCompact(input)} вход`,
          `${formatCompact(output)} выход`,
          inspected
            ? formatDayLabel(inspected.day)
            : `${formatMoney(perDay(totals.estimatedCost, days))}/день`,
        ].join(' · ')
      : null

  return (
    <div className="-mt-2">
      {facts && (
        <p aria-live="polite" className="max-w-2xl text-sm text-mute">
          {facts}
        </p>
      )}

      <SwapPane pane={pane} className="mt-6">
        {pane === 'skeleton' && <Skeleton className="h-32 rounded-2xl" />}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <EmptyHint>за период ничего не происходило</EmptyHint>}
        {pane === 'ready' && (
          <AreaTrend
            key={chartKey}
            days={dayAxis}
            series={callSeries}
            stacked={false}
            axis="x"
            format={formatCompact}
            height={108}
            active={cursor}
            onActiveChange={onCursor}
            ariaLabel={`вызовы api по дням за ${days} дней`}
          />
        )}
      </SwapPane>
    </div>
  )
})
