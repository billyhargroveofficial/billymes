import { describe, expect, it } from 'vitest'
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
} from './scale'

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale([0, 100], [0, 10])
    expect(scale(0)).toBe(0)
    expect(scale(50)).toBe(5)
    expect(scale(100)).toBe(10)
  })

  it('inverts for screen coordinates', () => {
    const scale = linearScale([0, 200], [180, 20])
    expect(scale(0)).toBe(180)
    expect(scale(200)).toBe(20)
  })

  it('collapses a zero-width domain onto the range start', () => {
    const scale = linearScale([0, 0], [180, 20])
    expect(scale(0)).toBe(180)
    expect(scale(99)).toBe(180)
  })
})

describe('niceTicks', () => {
  it('always covers the maximum', () => {
    const ticks = niceTicks(966_552_995, 4)
    expect(ticks[0]).toBe(0)
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(966_552_995)
    expect(ticks).toEqual([0, 250_000_000, 500_000_000, 750_000_000, 1_000_000_000])
  })

  it('produces round steps for small numbers', () => {
    expect(niceTicks(9, 4)).toEqual([0, 2.5, 5, 7.5, 10])
    expect(niceTicks(40, 4)).toEqual([0, 10, 20, 30, 40])
  })

  it('degrades to a unit axis when there is no data', () => {
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(Number.NaN)).toEqual([0, 1])
  })
})

describe('spanX', () => {
  it('spreads samples across the plot', () => {
    expect(spanX(3, 0, 100)).toEqual([0, 50, 100])
  })

  it('centres a single sample', () => {
    expect(spanX(1, 0, 100)).toEqual([50])
  })

  it('returns nothing for an empty series', () => {
    expect(spanX(0, 0, 100)).toEqual([])
  })
})

describe('path builders', () => {
  const points: Point[] = [
    [0, 0],
    [10, 20],
  ]

  it('draws a polyline', () => {
    expect(linePath(points)).toBe('M0 0 L10 20')
    expect(linePath([])).toBe('')
  })

  it('closes an area onto a flat baseline', () => {
    expect(areaPath(points, 30)).toBe('M0 0 L10 20 L10 30 L0 30 Z')
  })

  it('closes a band between two series', () => {
    expect(
      bandPath(points, [
        [0, 40],
        [10, 40],
      ]),
    ).toBe('M0 0 L10 20 L10 40 L0 40 Z')
  })

  it('rounds coordinates to two decimals', () => {
    expect(linePath([[1.23456, 7.89123]])).toBe('M1.23 7.89')
  })

  it('smooths three and more samples with cubic segments through every point', () => {
    const smooth = linePath([
      [0, 10],
      [10, 0],
      [20, 10],
    ])
    expect(smooth.startsWith('M0 10')).toBe(true)
    expect(smooth).toContain('C')
    expect(smooth).toContain('10 0')
    expect(smooth.endsWith('20 10')).toBe(true)
  })

  it('never overshoots past the data on a spike (monotone tangents)', () => {
    const path = linePath([
      [0, 100],
      [10, 0],
      [20, 0],
      [30, 100],
    ])
    const ys = [...path.matchAll(/[\d.]+ ([\d.-]+)/gu)].map((match) => Number(match[1]))
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(100)
  })

  it('keeps a flat series flat after smoothing', () => {
    const path = linePath([
      [0, 5],
      [10, 5],
      [20, 5],
    ])
    const ys = [...path.matchAll(/[\d.]+ ([\d.-]+)/gu)].map((match) => Number(match[1]))
    expect(new Set(ys)).toEqual(new Set([5]))
  })
})

describe('stackSeries', () => {
  it('accumulates layers', () => {
    expect(
      stackSeries([
        [1, 2],
        [3, 4],
      ]),
    ).toEqual([
      [1, 2],
      [4, 6],
    ])
  })

  it('treats holes as zero', () => {
    expect(stackSeries([[1], [3, 4]])).toEqual([
      [1, 0],
      [4, 4],
    ])
  })
})

describe('seriesMax', () => {
  it('finds the largest finite value', () => {
    expect(seriesMax([[1, 9], [4]])).toBe(9)
    expect(seriesMax([])).toBe(0)
  })
})
