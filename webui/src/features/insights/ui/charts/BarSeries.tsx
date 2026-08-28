import { memo } from 'react'
import { m } from '@/shared/ui/motion'
import { cn } from '@/shared/lib/cn'
import { CHART_TRACK, rankGradient } from './palette'

export type BarRow = {
  key: string
  label: string
  value: number
  hint?: string
  share?: string
}

const BAR_EASE = [0.22, 0.61, 0.36, 1] as const
const MAX_DELAY = 14

/** Compact ranked bars: name, figure, a thin track. */
export const BarSeries = memo(function BarSeries({
  rows,
  format,
  ariaLabel,
  colorIndex = 0,
  max,
  className,
}: {
  rows: readonly BarRow[]
  format: (value: number) => string
  ariaLabel: string
  colorIndex?: number
  max?: number
  className?: string
}) {
  const ceiling = Math.max(max ?? 0, ...rows.map((row) => (row.value > 0 ? row.value : 0)), 1)
  const gradient = rankGradient(colorIndex)
  return (
    <figure className={cn('m-0', className)}>
      <figcaption className="sr-only">{ariaLabel}</figcaption>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((row, index) => (
          <Bar
            key={row.key}
            rank={index + 1}
            row={row}
            gradient={gradient}
            share={(row.value / ceiling) * 100}
            text={format(row.value)}
            delay={Math.min(index, MAX_DELAY) * 0.04}
          />
        ))}
      </ol>
    </figure>
  )
})

const Bar = memo(function Bar({
  rank,
  row,
  gradient,
  share,
  text,
  delay,
}: {
  rank: number
  row: BarRow
  gradient: string
  share: number
  text: string
  delay: number
}) {
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="w-4 shrink-0 font-mono text-[10px] tabular-nums text-mute">
            {String(rank).padStart(2, '0')}
          </span>
          <span className="min-w-0 truncate text-sm text-paper" title={row.hint ?? row.label}>
            {row.label}
          </span>
        </span>
        <span className="flex shrink-0 items-baseline gap-2">
          <span className="text-sm tabular-nums text-paper">{text}</span>
          {row.share && (
            <span className="w-9 text-right font-mono text-[10px] tabular-nums text-mute">
              {row.share}
            </span>
          )}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="mt-1 h-1 overflow-hidden rounded-full"
        style={{ background: CHART_TRACK }}
      >
        <m.span
          className="block h-full rounded-full"
          style={{
            background: gradient,
            width: `${Math.max(2, Math.min(100, share))}%`,
            transformOrigin: 'left',
          }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.45, ease: BAR_EASE, delay }}
        />
      </div>
    </li>
  )
})
