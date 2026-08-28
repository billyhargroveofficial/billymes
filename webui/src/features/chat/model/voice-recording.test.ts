import { describe, expect, it } from 'vitest'
import {
  fmtRecordingSeconds,
  levelFromTimeDomain,
  pickRecordingMime,
  pushLevel,
} from './voice-recording'

describe('pickRecordingMime', () => {
  it('prefers webm/opus, falls back to mp4, then to the browser default', () => {
    expect(pickRecordingMime(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecordingMime((type) => type.startsWith('audio/mp4'))).toBe(
      'audio/mp4;codecs=mp4a.40.2',
    )
    expect(pickRecordingMime(() => false)).toBe('')
  })
})

describe('levelFromTimeDomain', () => {
  it('maps silence to 0 and a full-scale square wave to 1', () => {
    expect(levelFromTimeDomain(new Uint8Array([128, 128, 128, 128]))).toBe(0)
    expect(levelFromTimeDomain(new Uint8Array([0, 255, 0, 255]))).toBeCloseTo(1, 1)
    expect(levelFromTimeDomain(new Uint8Array())).toBe(0)
  })
})

describe('pushLevel', () => {
  it('appends and keeps only the trailing capacity', () => {
    expect(pushLevel([1, 2], 3, 4)).toEqual([1, 2, 3])
    expect(pushLevel([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
})

describe('fmtRecordingSeconds', () => {
  it('formats mm:ss and clamps negatives', () => {
    expect(fmtRecordingSeconds(7)).toBe('0:07')
    expect(fmtRecordingSeconds(95.8)).toBe('1:35')
    expect(fmtRecordingSeconds(-3)).toBe('0:00')
  })
})
