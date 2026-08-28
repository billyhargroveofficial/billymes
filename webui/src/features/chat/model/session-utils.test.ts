import { describe, expect, it } from 'vitest'
import {
  batchDeleteableSessionIds,
  estimateContext,
  isSessionPlaying,
  mergeUsage,
  sessionTurns,
} from './session-utils'

describe('session utilities', () => {
  it('counts a turn as one user–assistant exchange, never below one', () => {
    expect(sessionTurns(2)).toBe(1)
    expect(sessionTurns(5)).toBe(3)
    expect(sessionTurns(137)).toBe(69)
    expect(sessionTurns(0)).toBe(1)
  })

  it('marks only the selected live session as playing', () => {
    expect(isSessionPlaying('live-session', 'live-session')).toBe(true)
    expect(isSessionPlaying('historical-active-flag', null)).toBe(false)
    expect(isSessionPlaying('another-session', 'live-session')).toBe(false)
  })

  it('prefers explicit context accounting and caps percentages', () => {
    expect(estimateContext({ context_used: 120, context_max: 100 }, 100)).toEqual({
      used: 120,
      max: 100,
      pct: 100,
    })
    expect(estimateContext({ input_tokens: 25, reasoning_tokens: 5 }, 100)).toEqual({
      used: 30,
      max: 100,
      pct: 30,
    })
  })

  it('merges fresh usage while ignoring empty regressions', () => {
    expect(mergeUsage({ input: 12, output: 3 }, { input: 0, output: 4 })).toEqual({
      input: 12,
      output: 4,
    })
  })

  it('never includes active or playing sessions in a batch delete', () => {
    expect(
      batchDeleteableSessionIds(['old', 'active', 'playing', 'old'], 'active', 'playing'),
    ).toEqual(['old'])
  })
})
