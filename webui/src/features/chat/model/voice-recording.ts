/** Pure helpers behind the composer's voice input. */

/** Preference order covers Chrome/Firefox (webm/opus) and Safari (mp4/aac). */
const RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
] as const

/** Recordings auto-stop here; the gateway caps uploads at 25 MB anyway. */
export const MAX_RECORDING_SECONDS = 120

/** How many trailing levels the waveform keeps. */
const LEVEL_HISTORY = 96

export function pickRecordingMime(isTypeSupported: (type: string) => boolean): string {
  return RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type)) ?? ''
}

/**
 * Normalised RMS (0..1) of one analyser time-domain frame. Bytes arrive
 * centred at 128; silence is ~0, a full-scale square wave is ~1.
 */
export function levelFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const byte of samples) {
    const centered = (byte - 128) / 128
    sum += centered * centered
  }
  return Math.min(1, Math.sqrt(sum / samples.length))
}

/** Appends a level and trims the history to `capacity` trailing entries. */
export function pushLevel(history: readonly number[], level: number, capacity = LEVEL_HISTORY) {
  const next = [...history, level]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

/** «0:07» / «1:35» for the recording timer. */
export function fmtRecordingSeconds(total: number): string {
  const seconds = Math.max(0, Math.floor(total))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
