/**
 * One ordered series palette for every chart in this feature.
 *
 * The values are CSS colours built from the theme tokens, so both themes work
 * without a second definition and no chart ever hard-codes a hex value.
 * Daily series get canonical colours (input/calls/cost read as different
 * kinds of quantity); ranked lists cycle through the same set by index.
 */

const ACCENT = 'var(--accent)'
const SIGNAL = 'var(--signal)'
const OK = 'var(--ok)'
const EMBER = 'var(--ember)'
/** Cache reads are context, not action — a desaturated slate. */
const CACHE = 'color-mix(in oklab, var(--signal) 34%, var(--mute))'

/** Canonical colour per named daily series. */
export const DAILY_COLORS = {
  input: SIGNAL,
  output: OK,
  cache: CACHE,
  cost: ACCENT,
  calls: EMBER,
} as const

const RANK = [ACCENT, SIGNAL, OK, EMBER, CACHE] as const

export function rankColor(index: number): string {
  return RANK[index % RANK.length] ?? ACCENT
}

/** Horizontal gradient that gives ranked bars machined depth. */
export function rankGradient(index: number): string {
  const color = rankColor(index)
  return `linear-gradient(90deg, ${color}, color-mix(in oklab, ${color} 45%, var(--panel)))`
}

export const CHART_AXIS = 'color-mix(in oklab, var(--line) 80%, transparent)'
export const CHART_GUIDE = 'color-mix(in oklab, var(--mercury) 55%, transparent)'
export const CHART_TRACK = 'color-mix(in oklab, var(--paper) 7%, transparent)'
