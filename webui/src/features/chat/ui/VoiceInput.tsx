import { Check, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from '@/shared/lib/cn'
import { m } from '@/shared/ui/motion'
import { Spinner } from '@/shared/ui/spinner'
import { useVoiceInput } from '../model/use-voice-input'
import { fmtRecordingSeconds } from '../model/voice-recording'
import { VoiceWaveform } from './VoiceWaveform'

/**
 * The live recording strip. Loaded lazily by the composer on the first mic
 * press (the capture/waveform machinery stays out of the entry chunk),
 * starts recording on mount and reports back through `onClose` when the take
 * is transcribed, cancelled, or failed.
 */
export function VoiceInput({
  profile,
  scopeKey,
  onText,
  onClose,
}: {
  profile: string
  scopeKey: string
  onText: (text: string) => void
  onClose: (error: string | null) => void
}) {
  return (
    <ScopedVoiceInput
      key={`${profile}:${scopeKey}`}
      profile={profile}
      scopeKey={scopeKey}
      onText={onText}
      onClose={onClose}
    />
  )
}

function ScopedVoiceInput({
  profile,
  scopeKey,
  onText,
  onClose,
}: {
  profile: string
  scopeKey: string
  onText: (text: string) => void
  onClose: (error: string | null) => void
}) {
  const voice = useVoiceInput({ profile, scopeKey, onText })
  const launchedRef = useRef(false)
  const prevStatusRef = useRef(voice.status)
  const closeRef = useRef(onClose)
  const startRef = useRef(voice.start)

  useEffect(() => {
    closeRef.current = onClose
    startRef.current = voice.start
  })

  useEffect(() => {
    if (launchedRef.current) return
    launchedRef.current = true
    void startRef.current()
  }, [])

  useEffect(() => {
    const previous = prevStatusRef.current
    prevStatusRef.current = voice.status
    if (voice.status !== 'idle') return
    if (previous !== 'idle' || voice.error) closeRef.current(voice.error)
  }, [voice.status, voice.error])

  return (
    <div className="flex items-center gap-3 px-3 pb-2.5 pt-1">
      <span
        aria-hidden="true"
        className={cn(
          'size-2 shrink-0 rounded-full bg-ember',
          voice.status === 'recording' && 'motion-safe:animate-pulse',
        )}
      />
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-paper">
        {fmtRecordingSeconds(voice.seconds)}
      </span>
      <VoiceWaveform
        levelsRef={voice.levelsRef}
        active={voice.status === 'recording'}
        className="min-w-0 flex-1 text-accent"
      />
      {voice.status === 'transcribing' ? (
        <span className="inline-flex shrink-0 items-center gap-2 text-[11px] text-mute">
          <Spinner className="size-3" />
          расшифровываем…
        </span>
      ) : (
        <>
          <button
            type="button"
            aria-label="отменить запись"
            title="отменить запись"
            onClick={() => voice.stop(false)}
            className="grid size-7 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-ink/40 hover:text-paper"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
          <m.button
            whileTap={{ scale: 0.9 }}
            type="button"
            aria-label="закончить и расшифровать"
            title="закончить и расшифровать"
            onClick={() => voice.stop(true)}
            className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink hover:brightness-105"
          >
            <Check className="size-4" aria-hidden="true" />
          </m.button>
        </>
      )}
    </div>
  )
}
