import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { voiceApi } from '../api/voice-api'
import {
  levelFromTimeDomain,
  MAX_RECORDING_SECONDS,
  pickRecordingMime,
  pushLevel,
} from './voice-recording'
import { createAsyncScopeGuard, type AsyncScopeSnapshot } from './async-scope'

export type VoiceStatus = 'idle' | 'recording' | 'transcribing'

type RecordingSession = {
  recorder: MediaRecorder
  stream: MediaStream
  audio: AudioContext
  chunks: Blob[]
  raf: number
  timer: number
  accept: boolean
  scope: AsyncScopeSnapshot
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('не удалось прочитать запись'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Microphone capture for the composer: MediaRecorder collects the clip while
 * an AnalyserNode feeds `levelsRef` for the waveform (kept out of React state
 * so the memoised composer is not re-rendered on every animation frame). The
 * accepted clip goes to the gateway's STT (`/api/audio/transcribe`) and the
 * transcript is delivered through `onText`.
 */
export function useVoiceInput({
  profile,
  scopeKey,
  onText,
}: {
  profile: string
  scopeKey: string
  onText: (text: string) => void
}) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const levelsRef = useRef<number[]>([])
  const sessionRef = useRef<RecordingSession | null>(null)
  const transcriptionRef = useRef<AbortController | null>(null)
  // VoiceInput is keyed by profile/session, so one hook instance owns exactly
  // one immutable scope. Cleanup invalidates it before stopping media, which
  // also rejects a late FileReader or transcription completion after unmount.
  const scopeGuardRef = useRef(createAsyncScopeGuard({ profile, scopeKey }))
  const onTextRef = useRef(onText)
  useEffect(() => {
    onTextRef.current = onText
  }, [onText])

  useEffect(() => {
    const scopeGuard = scopeGuardRef.current
    return () => {
      const session = sessionRef.current
      scopeGuard.invalidate()
      transcriptionRef.current?.abort()
      transcriptionRef.current = null
      if (!session) return
      sessionRef.current = null
      session.recorder.ondataavailable = null
      session.recorder.onstop = null
      if (session.recorder.state !== 'inactive') session.recorder.stop()
      releaseMedia(session)
    }
  }, [])

  function releaseMedia(session: RecordingSession) {
    cancelAnimationFrame(session.raf)
    window.clearInterval(session.timer)
    for (const track of session.stream.getTracks()) track.stop()
    void session.audio.close().catch(() => undefined)
  }

  async function start() {
    if (sessionRef.current) return
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('микрофон в этом браузере недоступен')
      return
    }
    let stream: MediaStream
    const scope = scopeGuardRef.current.capture()
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (mediaError) {
      if (!scopeGuardRef.current.isCurrent(scope)) return
      const denied =
        mediaError instanceof DOMException &&
        (mediaError.name === 'NotAllowedError' || mediaError.name === 'SecurityError')
      setError(
        denied ? 'нет доступа к микрофону' : errorMessage(mediaError, 'микрофон не запустился'),
      )
      return
    }

    if (!scopeGuardRef.current.isCurrent(scope)) {
      for (const track of stream.getTracks()) track.stop()
      return
    }

    const mime = pickRecordingMime((type) => MediaRecorder.isTypeSupported(type))
    let recorder: MediaRecorder
    let audio: AudioContext
    let analyser: AnalyserNode
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      audio = new AudioContext()
      analyser = audio.createAnalyser()
      analyser.fftSize = 1024
      audio.createMediaStreamSource(stream).connect(analyser)
    } catch (setupError) {
      for (const track of stream.getTracks()) track.stop()
      if (scopeGuardRef.current.isCurrent(scope)) {
        setError(errorMessage(setupError, 'микрофон не запустился'))
      }
      return
    }
    const frame = new Uint8Array(analyser.fftSize)

    const session: RecordingSession = {
      recorder,
      stream,
      audio,
      chunks: [],
      raf: 0,
      timer: 0,
      accept: false,
      scope,
    }
    sessionRef.current = session
    levelsRef.current = []
    setSeconds(0)

    const sample = () => {
      analyser.getByteTimeDomainData(frame)
      levelsRef.current = pushLevel(levelsRef.current, levelFromTimeDomain(frame))
      session.raf = requestAnimationFrame(sample)
    }
    session.raf = requestAnimationFrame(sample)

    const startedAt = Date.now()
    session.timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000)
      setSeconds(elapsed)
      if (elapsed >= MAX_RECORDING_SECONDS) stop(true)
    }, 500)

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) session.chunks.push(event.data)
    }
    recorder.onstop = () => {
      if (sessionRef.current !== session) return
      sessionRef.current = null
      releaseMedia(session)
      if (!scopeGuardRef.current.isCurrent(session.scope)) return
      const type = recorder.mimeType || mime || 'audio/webm'
      const blob = new Blob(session.chunks, { type })
      if (!session.accept || blob.size === 0) {
        if (session.accept) setError('запись пустая — микрофон молчит')
        setStatus('idle')
        return
      }
      setStatus('transcribing')
      void transcribe(blob, type.split(';', 1)[0] ?? type, session.scope)
    }
    recorder.start(250)
    setStatus('recording')
  }

  async function transcribe(blob: Blob, mimeType: string, scope: AsyncScopeSnapshot) {
    const controller = new AbortController()
    transcriptionRef.current = controller
    try {
      const dataUrl = await blobToDataUrl(blob)
      if (!scopeGuardRef.current.isCurrent(scope)) return
      const text = await voiceApi.transcribe(dataUrl, mimeType, scope.profile, controller.signal)
      if (!scopeGuardRef.current.isCurrent(scope)) return
      if (text) onTextRef.current(text)
      else setError('речи не расслышал — попробуй ещё раз')
    } catch (transcribeError) {
      if (!scopeGuardRef.current.isCurrent(scope)) return
      setError(errorMessage(transcribeError, 'не удалось расшифровать запись'))
    } finally {
      if (transcriptionRef.current === controller) transcriptionRef.current = null
      if (scopeGuardRef.current.isCurrent(scope)) setStatus('idle')
    }
  }

  /** accept=true → transcribe the clip; accept=false → discard it. */
  function stop(accept: boolean) {
    const session = sessionRef.current
    if (!session || session.recorder.state === 'inactive') return
    session.accept = accept
    session.recorder.stop()
  }

  return { status, seconds, error, levelsRef, start, stop }
}
