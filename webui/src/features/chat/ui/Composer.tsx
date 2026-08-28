import { AnimatePresence } from 'motion/react'
import { ArrowUp, Mic, Paperclip, Square } from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ConnectionState } from '@/features/gateway'
import { cn } from '@/shared/lib/cn'
import { m } from '@/shared/ui/motion'
import { Spinner } from '@/shared/ui/spinner'
import type { SessionRuntime } from '../model/types'
import type { PendingAttachment } from '../model/use-attachments'
import { PendingAttachmentStrip } from './attachments'
import { StatusBar } from './StatusBar'

// Lazy: the capture/waveform/transcription machinery loads on the first mic
// press and stays out of the entry chunk (see the lazy-runtime ADR).
const VoiceInput = lazy(async () => {
  const module = await import('./VoiceInput')
  return { default: module.VoiceInput }
})

const ICON_SWAP = { duration: 0.14 }
const ICON_ENTER = { scale: 0.4, opacity: 0 }
const ICON_SETTLED = { scale: 1, opacity: 1 }
const MAX_HEIGHT = 220

/**
 * The desk console: a raised card that grows with the draft, sharpens on
 * focus, and swaps its action between «отправить» and «остановить». Memoised
 * so streamed tokens re-render it only when the props it reads change.
 */
export const Composer = memo(function Composer({
  draft,
  busy,
  historyReady,
  connectionState,
  runtime,
  reasoningSupported,
  profile,
  scopeKey,
  lastTurnFallback,
  attachments,
  onAttach,
  onRemoveAttachment,
  onDraft,
  onSend,
  onStop,
  onModel,
  onReasoning,
}: {
  draft: string
  busy: boolean
  historyReady: boolean
  connectionState: ConnectionState
  runtime: SessionRuntime
  reasoningSupported: boolean
  profile: string
  scopeKey: string
  lastTurnFallback: number | null
  attachments: PendingAttachment[]
  onAttach: (files: File[]) => void
  onRemoveAttachment: (id: string) => void
  onDraft: (text: string) => void
  onSend: () => void
  onStop: () => void
  onModel: (provider: string, model: string) => void
  onReasoning: (level: string) => void
}) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const draftRef = useRef(draft)
  useLayoutEffect(() => {
    draftRef.current = draft
  }, [draft])
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceScope, setVoiceScope] = useState({ profile, scopeKey })
  if (voiceScope.profile !== profile || voiceScope.scopeKey !== scopeKey) {
    // A take belongs to one profile/session only. Render-phase adjustment
    // closes the old recorder before the newly selected scope becomes visible,
    // without an effect-triggered extra render or an accidental new recording.
    setVoiceScope({ profile, scopeKey })
    setVoiceOpen(false)
    setVoiceError(null)
  }
  const onVoiceText = useCallback(
    (text: string) => {
      const base = draftRef.current.replace(/\s+$/u, '')
      onDraft(base ? `${base} ${text}` : text)
      areaRef.current?.focus()
    },
    [onDraft],
  )
  const onVoiceClose = useCallback((error: string | null) => {
    setVoiceOpen(false)
    setVoiceError(error)
  }, [])

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [draft])

  const attachmentsReady = attachments.some((item) => item.status === 'ready')
  const attachmentsUploading = attachments.some((item) => item.status === 'uploading')
  const canSend =
    (Boolean(draft.trim()) || attachmentsReady) && !attachmentsUploading && historyReady && !busy

  return (
    <form
      className="mx-auto w-full max-w-4xl"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) onSend()
      }}
    >
      <div className="composer-shell rounded-[1.6rem] border border-line bg-raised/95 shadow-lift backdrop-blur-sm">
        <PendingAttachmentStrip items={attachments} onRemove={onRemoveAttachment} />
        <textarea
          ref={areaRef}
          name="message"
          autoComplete="off"
          aria-label="сообщение"
          value={draft}
          placeholder="депеша профилю…"
          rows={1}
          className="max-h-[220px] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3.5 text-[0.95rem] leading-6 text-paper outline-none placeholder:text-mute/70"
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (canSend) onSend()
            }
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files]
            if (files.length) {
              event.preventDefault()
              onAttach(files)
            }
          }}
        />
        {voiceOpen && (
          <Suspense
            fallback={
              <div className="flex items-center gap-2 px-3 pb-2.5 pt-1 text-[11px] text-mute">
                <Spinner className="size-3" />
                микрофон…
              </div>
            }
          >
            <VoiceInput
              profile={profile}
              scopeKey={scopeKey}
              onText={onVoiceText}
              onClose={onVoiceClose}
            />
          </Suspense>
        )}
        <div className={cn('flex items-center gap-2 px-3 pb-2.5 pt-1', voiceOpen && 'hidden')}>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              if (files.length) onAttach(files)
              event.target.value = ''
            }}
          />
          <button
            type="button"
            aria-label="прикрепить файлы"
            title="прикрепить файлы"
            onClick={() => fileRef.current?.click()}
            className="grid size-7 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-ink/40 hover:text-paper"
          >
            <Paperclip className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="надиктовать голосом"
            title="надиктовать голосом"
            onClick={() => {
              setVoiceError(null)
              setVoiceOpen(true)
            }}
            className="grid size-7 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-ink/40 hover:text-paper"
          >
            <Mic className="size-3.5" aria-hidden="true" />
          </button>
          {voiceError && (
            <span className="truncate text-[11px] text-ember" title={voiceError}>
              {voiceError}
            </span>
          )}
          <StatusBar
            runtime={runtime}
            busy={busy}
            connectionState={connectionState}
            reasoningSupported={reasoningSupported}
            profile={profile}
            lastTurnFallback={lastTurnFallback}
            onModel={onModel}
            onReasoning={onReasoning}
          />
          <span className="hidden shrink-0 font-mono text-[10px] text-mute/60 md:inline">
            ⇧↵ — перенос
          </span>
          <m.button
            whileTap={{ scale: 0.9 }}
            type={busy ? 'button' : 'submit'}
            aria-label={busy ? 'остановить ответ' : 'отправить сообщение'}
            disabled={!busy && !canSend}
            onClick={busy ? onStop : undefined}
            className={cn(
              'relative grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-200 disabled:opacity-35',
              busy ? 'bg-ember text-accent-ink' : 'bg-accent text-accent-ink hover:brightness-105',
            )}
          >
            {busy && (
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-ember/50 motion-safe:animate-ping"
              />
            )}
            <AnimatePresence mode="wait" initial={false}>
              <m.span
                key={busy ? 'stop' : 'send'}
                initial={ICON_ENTER}
                animate={ICON_SETTLED}
                exit={ICON_ENTER}
                transition={ICON_SWAP}
                className="relative grid place-items-center"
              >
                {busy ? <Square className="size-3.5" /> : <ArrowUp className="size-4" />}
              </m.span>
            </AnimatePresence>
          </m.button>
        </div>
      </div>
    </form>
  )
})
