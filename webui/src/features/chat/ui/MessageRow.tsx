import { Check, Copy } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { Markdown } from '@/shared/ui/Markdown'
import { EASE_SOFT, m } from '@/shared/ui/motion'
import { findImagePaths, splitAttachments } from '../model/attachments'
import { fmtClock } from '../model/format'
import type { ChatMessage } from '../model/types'
import { ActivityTimeline, TodoPanel } from './activity-blocks'
import { MessageAttachments } from './attachments'

const USER_ENTER = { opacity: 0, y: 14, scale: 0.96 }
const ASSISTANT_ENTER = { opacity: 0, y: 10 }
const SETTLED = { opacity: 1, y: 0, scale: 1 }

/**
 * Copies through the async clipboard API and falls back to a hidden textarea
 * for non-secure origins; failures stay silent because a broken copy affordance
 * must never take the thread down.
 */
function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => undefined)
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  } catch {
    /* clipboard unavailable */
  }
  return Promise.resolve()
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      aria-label="скопировать сообщение"
      title="скопировать"
      onClick={() => {
        void copyText(text)
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1300)
      }}
      className={cn(
        'grid size-6 place-items-center rounded-md text-mute transition-colors hover:bg-raised hover:text-paper',
        className,
      )}
    >
      {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
    </button>
  )
}

/** Timestamp plus copy — hidden until the reader hovers the message. */
function RowMeta({ message, mine }: { message: ChatMessage; mine: boolean }) {
  const time = fmtClock(message.timestamp)
  return (
    <div
      className={cn(
        'flex h-6 items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/msg:opacity-100',
        mine ? 'justify-end pr-1' : 'pl-0.5',
      )}
    >
      {time && <span className="font-mono text-[10px] tabular-nums text-mute">{time}</span>}
      {message.content && <CopyButton text={message.content} />}
    </div>
  )
}

export const MessageRow = memo(function MessageRow({
  message,
  withHeader = true,
}: {
  message: ChatMessage
  /** Consecutive assistant segments share one header — set by the thread. */
  withHeader?: boolean
}) {
  const mine = message.role === 'user'
  const system = message.role === 'system'

  if (system) {
    return (
      <m.article
        initial={ASSISTANT_ENTER}
        animate={SETTLED}
        transition={EASE_SOFT}
        className="flex justify-center"
      >
        <p className="max-w-[min(92%,36rem)] rounded-2xl border border-ember/35 bg-ember/10 px-4 py-2 text-center text-xs leading-5 text-ember">
          {message.content}
        </p>
      </m.article>
    )
  }

  if (mine) {
    const { text, attachments } = splitAttachments(message.content)
    return (
      <m.article
        initial={USER_ENTER}
        animate={SETTLED}
        transition={EASE_SOFT}
        className="group/msg flex flex-col items-end"
      >
        <div className="flex min-w-0 max-w-[min(88%,42rem)] flex-col items-end gap-1.5">
          {text && (
            <div className="min-w-0 max-w-full rounded-3xl rounded-br-lg bg-bubble px-4 py-2.5 text-left text-on-bubble shadow-lift">
              <p className="whitespace-pre-wrap text-[0.925rem] leading-6 [overflow-wrap:anywhere]">
                {text}
              </p>
            </div>
          )}
          <MessageAttachments attachments={attachments} />
        </div>
        <RowMeta message={message} mine />
      </m.article>
    )
  }

  const busy = message.streaming && !message.content
  const { text: assistantText, attachments: assistantAttachments } = splitAttachments(
    message.content,
  )
  const proseImages = message.streaming ? [] : findImagePaths(assistantText)
  const shownAttachments = [
    ...assistantAttachments,
    ...proseImages
      .filter((path) => assistantAttachments.every((item) => item.path !== path))
      .map((path) => ({ kind: 'image' as const, path, name: path.split('/').pop() ?? path })),
  ]
  return (
    <m.article
      initial={ASSISTANT_ENTER}
      animate={SETTLED}
      transition={EASE_SOFT}
      className="group/msg flex min-w-0 flex-col items-start"
    >
      {withHeader && (
        <header className="mb-1.5 flex h-5 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('size-1.5 rounded-full bg-accent', busy && 'pulse-soft')}
          />
          <span className="font-display text-[13px] italic leading-none text-mercury">hermes</span>
        </header>
      )}
      <div className="w-full min-w-0 space-y-2 pl-3.5">
        <ActivityTimeline
          thinking={message.thinking}
          thinkingLive={message.streaming && !message.content && !message.thinking}
          tools={message.tools}
          subagents={message.subagents}
        />
        {assistantText ? (
          <div className="min-w-0">
            <Markdown text={assistantText} />
            {message.streaming && <span aria-hidden="true" className="stream-caret" />}
          </div>
        ) : null}
        <MessageAttachments attachments={shownAttachments} />
        <TodoPanel todos={message.todos} />
      </div>
      {message.content && !message.streaming && (
        <div className="pl-3.5">
          <RowMeta message={message} mine={false} />
        </div>
      )}
    </m.article>
  )
})
