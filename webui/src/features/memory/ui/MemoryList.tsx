import { Check, ChevronDown, Copy, FileText, Maximize2, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { Markdown } from '@/shared/ui/Markdown'
import { StaggerItem } from '@/shared/ui/motion'
import { relativeTime, titleAddsInformation } from '../model/graph-view'
import type { MemoryEntry } from '../model/types'

/** Bodies longer than this get a «развернуть» toggle instead of the full text. */
const COLLAPSE_AT = 260

const SOURCE_META: Record<string, { label: string; icon: LucideIcon }> = {
  memory: { label: 'MEMORY.md', icon: FileText },
  profile: { label: 'о пользователе', icon: UserRound },
}

/** Fades a clipped body out without having to guess the surface colour. */
const FADE_OUT = {
  maskImage: 'linear-gradient(to bottom, #000 58%, transparent 100%)',
  WebkitMaskImage: 'linear-gradient(to bottom, #000 58%, transparent 100%)',
} as const

/**
 * Memory chunks as a card wall. The cards are deliberately not one big click
 * target: the bodies are text a reader selects and copies, so opening and
 * copying live in their own controls in the card header.
 */
export function MemoryList({
  entries,
  now,
  selectedId,
  onOpen,
}: {
  entries: readonly MemoryEntry[]
  now: number
  selectedId: string | null
  onOpen: (id: string) => void
}) {
  return (
    <div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {entries.map((entry, index) => (
        <StaggerItem key={entry.id} index={index}>
          <MemoryCard entry={entry} now={now} selected={entry.id === selectedId} onOpen={onOpen} />
        </StaggerItem>
      ))}
    </div>
  )
}

const MemoryCard = memo(function MemoryCard({
  entry,
  now,
  selected,
  onOpen,
}: {
  entry: MemoryEntry
  now: number
  selected: boolean
  onOpen: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = entry.body.length > COLLAPSE_AT
  const clipped = collapsible && !expanded
  const heading = titleAddsInformation(entry.title, entry.body) ? entry.title : null
  const source = SOURCE_META[entry.source] ?? { label: entry.source, icon: FileText }
  const Glyph = source.icon

  return (
    <article
      data-selected={String(selected)}
      className="card-interactive group/card flex flex-col rounded-2xl border border-line bg-panel/40 p-3.5"
    >
      <header className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-line/70 bg-raised/50 text-mercury">
          <Glyph aria-hidden="true" className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] leading-none">
          <span className="uppercase tracking-[0.14em] text-mute">{source.label}</span>
          <span aria-hidden="true" className="text-mute/40">
            {' '}
            ·{' '}
          </span>
          <span className="text-mute/70">{relativeTime(entry.timestamp, now)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100">
          <CopyBodyButton body={entry.body} />
          <button
            type="button"
            aria-label={`открыть воспоминание «${entry.title}»`}
            title="открыть"
            onClick={() => onOpen(entry.id)}
            className="grid size-6 place-items-center rounded-md border border-line/70 bg-panel/70 text-mute transition-colors hover:text-paper"
          >
            <Maximize2 aria-hidden="true" className="size-3" />
          </button>
        </span>
      </header>

      {heading && (
        <h3 className="mt-2.5 break-words text-sm font-medium leading-snug text-paper">
          {heading}
        </h3>
      )}

      <div
        className={cn(
          'mt-2 min-w-0 [&_.markdown]:text-[0.875rem] [&_.markdown]:leading-[1.62]',
          clipped && 'max-h-40 overflow-hidden',
        )}
        {...(clipped ? { style: FADE_OUT } : {})}
      >
        <Markdown text={entry.body} />
      </div>

      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 inline-flex items-center gap-1 self-start text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3 transition-transform duration-200 motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
          />
          {expanded ? 'свернуть' : 'развернуть'}
        </button>
      )}
    </article>
  )
})

/** Copies the raw chunk text — the thing worth keeping out of a memory card. */
function CopyBodyButton({ body }: { body: string }) {
  const timer = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      aria-label={copied ? 'текст скопирован' : 'скопировать текст'}
      title="скопировать"
      onClick={() => {
        void navigator.clipboard?.writeText(body).catch(() => undefined)
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1300)
      }}
      className="grid size-6 place-items-center rounded-md border border-line/70 bg-panel/70 text-mute transition-colors hover:text-paper"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3 text-ok" />
      ) : (
        <Copy aria-hidden="true" className="size-3" />
      )}
    </button>
  )
}
