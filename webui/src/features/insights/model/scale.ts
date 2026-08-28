/**
 * Minimal plotting maths for the hand-built chart kit.
 *
 * Everything here is pure and unit-tested: the charts only turn these numbers
 * into SVG, so the geometry can be checked without a DOM.
 */

export type Point = readonly [x: number, y: number]

/** Maps a value from `domain` onto `range`, without clamping. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0
  if (!Number.isFinite(span) || span === 0) return () => r0
  const k = (r1 - r0) / span
  return (value) => r0 + (value - d0) * k
}

const STEPS = [1, 2, 2.5, 5, 10] as const

/**
 * Ticks from zero up to the first "round" value at or above `max`. The last
 * tick is the axis maximum, so a caller can scale against `ticks.at(-1)`.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1]
  const target = Math.max(1, Math.floor(count))
  const rough = max / target
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const normalised = rough / magnitude
  const step = (STEPS.find((candidate) => normalised <= candidate) ?? 10) * magnitude
  const last = Math.ceil(max / step - 1e-9)
  const ticks: number[] = []
  for (let index = 0; index <= last; index += 1) ticks.push(round(index * step))
  return ticks
}

/** Even x positions for `count` samples; a single sample sits in the middle. */
export function spanX(count: number, left: number, right: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [round((left + right) / 2)]
  const step = (right - left) / (count - 1)
  return Array.from({ length: count }, (_, index) => round(left + index * step))
}

/**
 * Fritsch–Carlson tangents (the curve d3 calls monotone-x): smooth, but the
 * curve never overshoots past its data — a spike down to zero stays at zero.
 */
function monotoneTangents(points: readonly Point[]): number[] {
  const slopes: number[] = []
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index] as Point
    const [x1, y1] = points[index + 1] as Point
    const h = x1 - x0
    slopes.push(h === 0 ? 0 : (y1 - y0) / h)
  }
  const tangents = new Array<number>(points.length)
  tangents[0] = slopes[0] ?? 0
  tangents[points.length - 1] = slopes[slopes.length - 1] ?? 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = slopes[index - 1] ?? 0
    const after = slopes[index] ?? 0
    if (before * after <= 0) {
      tangents[index] = 0
      continue
    }
    const [xPrev] = points[index - 1] as Point
    const [xHere] = points[index] as Point
    const [xNext] = points[index + 1] as Point
    const h0 = xHere - xPrev
    const h1 = xNext - xHere
    const weighted = (before * h1 + after * h0) / (h0 + h1)
    const cap = 3 * Math.min(Math.abs(before), Math.abs(after))
    tangents[index] = Math.sign(weighted) * Math.min(Math.abs(weighted), cap)
  }
  return tangents
}

function curveFrom(points: readonly Point[], lead: 'M' | 'L'): string {
  const [firstX, firstY] = points[0] as Point
  let path = `${lead}${round(firstX)} ${round(firstY)}`
  if (points.length === 1) return path
  if (points.length === 2) {
    const [x, y] = points[1] as Point
    return `${path} L${round(x)} ${round(y)}`
  }
  const tangents = monotoneTangents(points)
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1] as Point
    const [x1, y1] = points[index] as Point
    const h = (x1 - x0) / 3
    const c1y = y0 + (tangents[index - 1] ?? 0) * h
    const c2y = y1 - (tangents[index] ?? 0) * h
    path += ` C${round(x0 + h)} ${round(c1y)} ${round(x1 - h)} ${round(c2y)} ${round(x1)} ${round(y1)}`
  }
  return path
}

export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return ''
  return curveFrom(points, 'M')
}

/** Filled area between the series and a flat baseline. */
export function areaPath(points: readonly Point[], baseline: number): string {
  if (points.length === 0) return ''
  const first = points[0] as Point
  const last = points[points.length - 1] as Point
  return `${linePath(points)} L${round(last[0])} ${round(baseline)} L${round(first[0])} ${round(baseline)} Z`
}

/** Filled band between two series — the building block of a stacked area. */
export function bandPath(top: readonly Point[], bottom: readonly Point[]): string {
  if (top.length === 0 || bottom.length === 0) return ''
  const back = [...bottom].reverse()
  return `${curveFrom(top, 'M')} ${curveFrom(back, 'L')} Z`
}

/** Running totals per sample index — series[i] stacked on top of series[i-1]. */
export function stackSeries(series: readonly (readonly number[])[]): number[][] {
  const length = series.reduce((max, values) => Math.max(max, values.length), 0)
  const running = new Array<number>(length).fill(0)
  return series.map((values) => {
    const layer = new Array<number>(length)
    for (let index = 0; index < length; index += 1) {
      const previous = running[index] ?? 0
      const next = previous + safe(values[index])
      running[index] = next
      layer[index] = next
    }
    return layer
  })
}

export function seriesMax(series: readonly (readonly number[])[]): number {
  let max = 0
  for (const values of series) for (const value of values) max = Math.max(max, safe(value))
  return max
}

function safe(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
