import { memo, useCallback, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import { EASE_OUT, m } from '@/shared/ui/motion'
import { formatDayLabel } from '../../model/format'
import {
  areaPath,
  bandPath,
  linePath,
  linearScale,
  niceTicks,
  seriesMax,
  spanX,
  stackSeries,
  type Point,
} from '../../model/scale'
import { ChartFigure, type ChartTable } from './ChartFigure'
import { CHART_AXIS, CHART_GUIDE, rankColor } from './palette'

export type TrendSeries = {
  key: string
  label: string
  values: readonly number[]
  /** Canonical colour; falls back to the ranked palette by position. */
  color?: string
}

const VIEW_WIDTH = 720
const PAD_FULL = { top: 16, right: 28, bottom: 26, left: 58 } as const
const PAD_X = { top: 10, right: 22, bottom: 22, left: 10 } as const
const X_LABEL_TARGET = 6
const LINE_EASE = [0.16, 1, 0.3, 1] as const

type Axis = 'full' | 'x'

/**
 * Stacked (or layered) daily area chart drawn by hand into a viewBox, so it
 * scales with its container without a single layout measurement. Series draw
 * their stroke in and fade their gradient fill on mount; a crosshair with a
 * floating readout follows the pointer or the arrow keys.
 */
export const AreaTrend = memo(function AreaTrend({
  days,
  series,
  format,
  ariaLabel,
  height = 240,
  stacked = true,
  axis = 'full',
  active,
  onActiveChange,
  peakIndex,
  className,
}: {
  days: readonly string[]
  series: readonly TrendSeries[]
  format: (value: number) => string
  ariaLabel: string
  height?: number
  stacked?: boolean
  /** `x` hides the value axis so small multiples can spend the width on shape. */
  axis?: Axis
  active?: number | null
  onActiveChange?: (index: number | null) => void
  peakIndex?: number | null
  className?: string
}) {
  const [localActive, setLocalActive] = useState<number | null>(null)
  const gradientBase = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const pad = axis === 'full' ? PAD_FULL : PAD_X
  const current = active !== undefined ? active : localActive

  const setCurrent = useCallback(
    (index: number | null) => {
      if (active === undefined) setLocalActive(index)
      onActiveChange?.(index)
    },
    [active, onActiveChange],
  )

  const geometry = useMemo(() => {
    const values = series.map((entry) => entry.values)
    const layers = stacked ? stackSeries(values) : values.map((entry) => entry.slice())
    const ticks = niceTicks(seriesMax(layers), axis === 'full' ? 4 : 3)
    const axisMax = ticks[ticks.length - 1] ?? 1
    const y = linearScale([0, axisMax], [height - pad.bottom, pad.top])
    const xs = spanX(days.length, pad.left, VIEW_WIDTH - pad.right)
    const toPoints = (row: readonly number[]): Point[] =>
      xs.map((x, index) => [x, y(row[index] ?? 0)] as Point)
    const baseline = y(0)
    const bands = layers.map((layer, index) => {
      const top = toPoints(layer)
      const below = stacked && index > 0 ? layers[index - 1] : undefined
      return {
        fill: below ? bandPath(top, toPoints(below)) : areaPath(top, baseline),
        line: linePath(top),
        tops: top,
      }
    })
    const step = Math.max(1, Math.ceil(days.length / X_LABEL_TARGET))
    const xLabels = days.flatMap((day, index) =>
      index % step === 0 || index === days.length - 1
        ? [{ day, x: xs[index] ?? pad.left, index }]
        : [],
    )
    return { ticks, y, xs, bands, baseline, xLabels }
  }, [axis, days, height, pad.bottom, pad.left, pad.right, pad.top, series, stacked])

  const table = useMemo<ChartTable>(
    () => ({
      head: ['день', ...series.map((entry) => entry.label)],
      rows: days.map((day, index) => [
        day,
        ...series.map((entry) => format(entry.values[index] ?? 0)),
      ]),
    }),
    [days, format, series],
  )

  const pick = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      const box = target.getBoundingClientRect()
      if (box.width <= 0 || days.length === 0) return
      const ratio = (clientX - box.left) / box.width
      const plotStart = pad.left / VIEW_WIDTH
      const plotSpan = (VIEW_WIDTH - pad.right - pad.left) / VIEW_WIDTH
      const position = (ratio - plotStart) / plotSpan
      const index = Math.round(position * Math.max(1, days.length - 1))
      setCurrent(Math.min(days.length - 1, Math.max(0, index)))
    },
    [days.length, pad.left, pad.right, setCurrent],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const base = current ?? days.length - 1
      const next = base + (event.key === 'ArrowRight' ? 1 : -1)
      setCurrent(Math.min(days.length - 1, Math.max(0, next)))
    },
    [current, days.length, setCurrent],
  )

  const seriesColor = useCallback(
    (index: number) => series[index]?.color ?? rankColor(index),
    [series],
  )

  const activeDay = current == null ? null : days[current]
  const activeLeft =
    current == null
      ? null
      : Math.min(86, Math.max(14, ((geometry.xs[current] ?? 0) / VIEW_WIDTH) * 100))
  const peakPoint =
    peakIndex == null ? null : (geometry.bands[geometry.bands.length - 1]?.tops[peakIndex] ?? null)
  const peakDay = peakIndex == null ? null : days[peakIndex]
  const markEnd = !stacked && series.length === 1
  const lastPoint = markEnd ? (geometry.bands[0]?.tops.at(-1) ?? null) : null

  return (
    <ChartFigure table={table} {...(className ? { className } : {})}>
      <div className="relative min-w-0">
        <svg
          role="img"
          aria-label={`${ariaLabel}. Наведи курсор или используй стрелки, чтобы увидеть значения по дням`}
          tabIndex={0}
          viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
          className="h-auto w-full max-w-full rounded-2xl outline-offset-4"
          onPointerMove={(event) => pick(event.clientX, event.currentTarget)}
          onPointerLeave={() => setCurrent(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setCurrent(null)}
        >
          <defs>
            {series.map((entry, index) => (
              <linearGradient
                key={entry.key}
                id={`${gradientBase}-${entry.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" style={{ stopColor: seriesColor(index), stopOpacity: 0.5 }} />
                <stop offset="100%" style={{ stopColor: seriesColor(index), stopOpacity: 0.03 }} />
              </linearGradient>
            ))}
          </defs>

          {geometry.ticks.map((tick) => {
            const y = geometry.y(tick)
            return (
              <g key={tick}>
                <line
                  x1={pad.left}
                  x2={VIEW_WIDTH - pad.right}
                  y1={y}
                  y2={y}
                  style={{ stroke: CHART_AXIS }}
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                {axis === 'full' && (
                  <text
                    x={pad.left - 8}
                    y={y + 4}
                    textAnchor="end"
                    className="fill-current text-mute tabular-nums"
                    fontSize={11}
                  >
                    {format(tick)}
                  </text>
                )}
              </g>
            )
          })}

          <AnimatePresence initial>
            {series.map((entry, index) => {
              const band = geometry.bands[index]
              if (!band) return null
              return (
                <m.g key={entry.key} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  <m.path
                    d={band.fill}
                    fill={`url(#${gradientBase}-${entry.key})`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.85, delay: 0.28 + index * 0.1, ease: LINE_EASE }}
                  />
                  <m.path
                    d={band.line}
                    fill="none"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    style={{ stroke: seriesColor(index) }}
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={{ pathLength: 1, opacity: 1 }}
                    transition={{
                      pathLength: { duration: 1, delay: index * 0.1, ease: LINE_EASE },
                      opacity: { duration: 0.25, delay: index * 0.1 },
                    }}
                  />
                </m.g>
              )
            })}
          </AnimatePresence>

          {lastPoint && (
            <m.circle
              cx={lastPoint[0]}
              cy={lastPoint[1]}
              r={3.5}
              style={{
                fill: seriesColor(0),
                stroke: 'var(--ink)',
                strokeWidth: 1.5,
              }}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.9, ease: LINE_EASE }}
            />
          )}

          {peakPoint && peakDay && current == null && (peakIndex ?? -1) !== days.length - 1 && (
            <g>
              <m.circle
                cx={peakPoint[0]}
                cy={peakPoint[1]}
                r={3.5}
                style={{ fill: 'var(--ember)', stroke: 'var(--ink)', strokeWidth: 1.5 }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.4, delay: 1, ease: LINE_EASE }}
              />
              <text
                x={Math.min(VIEW_WIDTH - 48, Math.max(pad.left, peakPoint[0] + 8))}
                y={Math.max(pad.top + 10, peakPoint[1] - 8)}
                className="fill-current text-ember"
                fontSize={10}
              >
                пик {formatDayLabel(peakDay)}
              </text>
            </g>
          )}

          {current != null && (
            <g>
              <line
                x1={geometry.xs[current] ?? 0}
                x2={geometry.xs[current] ?? 0}
                y1={pad.top}
                y2={height - pad.bottom}
                strokeWidth={1}
                style={{ stroke: CHART_GUIDE }}
                vectorEffect="non-scaling-stroke"
              />
              {geometry.bands.map((band, bandIndex) => {
                const point = band.tops[current]
                if (!point) return null
                return (
                  <circle
                    key={series[bandIndex]?.key ?? bandIndex}
                    cx={point[0]}
                    cy={point[1]}
                    r={3.5}
                    style={{
                      fill: seriesColor(bandIndex),
                      stroke: 'var(--ink)',
                      strokeWidth: 1.5,
                    }}
                  />
                )
              })}
            </g>
          )}

          {geometry.xLabels.map((entry, index) => (
            <text
              key={entry.day}
              x={entry.x}
              y={height - 7}
              textAnchor={
                index === 0 ? 'start' : index === geometry.xLabels.length - 1 ? 'end' : 'middle'
              }
              className="fill-current text-mute"
              fontSize={11}
            >
              {formatDayLabel(entry.day)}
            </text>
          ))}
        </svg>

        <AnimatePresence>
          {current != null && activeLeft != null && activeDay != null && (
            <div
              className="pointer-events-none absolute top-2 z-10 -translate-x-1/2"
              style={{ left: `${activeLeft}%` }}
            >
              <m.div
                key="readout"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 4 }}
                transition={EASE_OUT}
                className="min-w-36 rounded-2xl border border-line bg-raised/95 px-3 py-2 shadow-lift backdrop-blur-sm"
              >
                <div className="font-mono text-[11px] text-mercury">
                  {formatDayLabel(activeDay)}
                </div>
                {series.map((entry, index) => (
                  <div
                    key={entry.key}
                    className="mt-1 flex items-center justify-between gap-4 text-[11px]"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-mute">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: seriesColor(index) }}
                      />
                      {entry.label}
                    </span>
                    <span className="tabular-nums text-paper">
                      {format(entry.values[current] ?? 0)}
                    </span>
                  </div>
                ))}
              </m.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </ChartFigure>
  )
})
