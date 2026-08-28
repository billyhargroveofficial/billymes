import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Clock3, FileText, Pin, Repeat2, ScrollText } from 'lucide-react'
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Textarea } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/Markdown'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { SkeletonBlock, SkeletonText, Skeleton } from '@/shared/ui/skeleton'
import { memoryApi } from '../api/memory-api'
import { categoryHue } from '../model/category-color'
import { splitFrontmatter } from '../model/frontmatter'
import { relativeTime } from '../model/graph-view'
import type { LearningNode } from '../model/types'

const MEMORY_SOURCE_LABEL: Record<string, string> = {
  memory: 'MEMORY.md',
  profile: 'о пользователе',
}

const ARCHIVED = 'скилл заархивирован — его можно вернуть'
const ERASED = 'удалено безвозвратно'

/**
 * Read/edit surface for one learning node. Skills carry a SKILL.md, memory
 * chunks carry raw text; both are rendered through the shared Markdown
 * component and rewritten through `PUT /api/learning/node`.
 *
 * Callers key this component by node id, so the draft/confirm state resets by
 * remount rather than by an effect.
 */
export function NodeDetail({
  nodeId,
  profile,
  meta,
  now,
  showHeader = true,
  onDeleted,
}: {
  nodeId: string
  profile: string
  meta: LearningNode | null
  now: number
  /** The sheet already prints the node's name in its own title bar. */
  showHeader?: boolean
  onDeleted: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ['memory', 'node', profile, nodeId],
    queryFn: () => memoryApi.node(nodeId, profile),
  })
  const [draft, setDraft] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const kind = detail.data?.kind ?? meta?.kind ?? 'skill'
  const label = detail.data?.label ?? meta?.label ?? nodeId
  const content = detail.data?.content ?? ''

  const save = useMutation({
    mutationFn: (next: string) => memoryApi.saveNode(nodeId, next, profile),
    onSuccess: async () => {
      setDraft(null)
      setNotice(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['memory', 'node', profile, nodeId] })
      await queryClient.invalidateQueries({ queryKey: ['memory', 'graph', profile] })
    },
    onError: (error) => setNotice(errorMessage(error, 'не удалось сохранить')),
  })

  const remove = useMutation({
    mutationFn: () => memoryApi.deleteNode(nodeId, profile),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['memory', 'graph', profile] })
      onDeleted(kind === 'skill' ? ARCHIVED : ERASED)
    },
    onError: (error) => setNotice(errorMessage(error, 'не удалось удалить')),
  })

  const busy = save.isPending || remove.isPending
  const pane = detail.isPending
    ? 'skeleton'
    : detail.error
      ? 'error'
      : draft !== null
        ? 'edit'
        : content
          ? 'ready'
          : 'empty'

  return (
    <article className="min-w-0">
      <header className="border-b border-line pb-4">
        {showHeader && (
          <>
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-lg border border-line/70 bg-raised/50 text-mercury"
              >
                {kind === 'skill' ? (
                  <ScrollText className="size-3.5" />
                ) : (
                  <FileText className="size-3.5" />
                )}
              </span>
              <span className="text-[10px] uppercase tracking-[0.2em] text-mute">
                {kind === 'skill' ? 'SKILL.md' : 'воспоминание'}
              </span>
            </div>
            <h3 className="mt-2 break-words font-display text-2xl italic leading-tight text-mercury">
              {label}
            </h3>
          </>
        )}
        <NodeMeta meta={meta} now={now} className={showHeader ? 'mt-3' : ''} />
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-b border-line/60 pb-4">
        {draft === null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !detail.data}
            onClick={() => {
              setSaved(false)
              setDraft(content)
            }}
          >
            править
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'сохраняем…' : 'сохранить'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              отмена
            </Button>
          </>
        )}
        {confirming ? (
          <>
            <Button size="sm" variant="ember" disabled={busy} onClick={() => remove.mutate()}>
              {remove.isPending
                ? 'убираем…'
                : kind === 'skill'
                  ? 'точно заархивировать'
                  : 'точно удалить'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              отмена
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-ember"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {kind === 'skill' ? 'заархивировать' : 'удалить'}
          </Button>
        )}
      </div>

      {confirming && (
        <p className="mt-2 text-xs text-mute">
          {kind === 'skill' ? ARCHIVED : `${ERASED} — восстановить нельзя`}
        </p>
      )}
      {notice && <Notice className="mt-2">{notice}</Notice>}
      {saved && !notice && (
        <Notice tone="success" className="mt-2">
          сохранено
        </Notice>
      )}

      <SwapPane pane={pane} className="mt-4 min-w-0">
        {pane === 'skeleton' ? (
          <SkeletonBlock label="читаем узел" className="space-y-3">
            <Skeleton className="h-3 w-40" />
            <SkeletonText lines={5} />
          </SkeletonBlock>
        ) : pane === 'error' ? (
          <Notice>{errorMessage(detail.error, 'не удалось прочитать узел')}</Notice>
        ) : pane === 'edit' ? (
          <Textarea
            aria-label={`содержимое узла ${label}`}
            className="min-h-[24rem] font-mono text-xs leading-6"
            value={draft ?? ''}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : pane === 'empty' ? (
          <p className="text-sm text-mute">узел пустой</p>
        ) : (
          <NodeBody content={content} />
        )}
      </SwapPane>
    </article>
  )
}

/**
 * Skill files carry a YAML header. Rendering it as markdown turns the keys
 * into a setext heading, so it is split off and shown as what it is: a short
 * description plus a row of declared facts.
 */
function NodeBody({ content }: { content: string }) {
  const { fields, body } = splitFrontmatter(content)
  const description = fields.find((field) => field.key === 'description')?.value ?? ''
  const facts = fields.filter((field) => field.key !== 'name' && field.key !== 'description')

  return (
    <div className="min-w-0">
      {description && <p className="text-sm leading-6 text-paper/90">{description}</p>}
      {facts.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-1.5">
          {facts.map((field) => (
            <div
              key={field.key}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-line/70 bg-raised/40 px-2 py-1"
            >
              <dt className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-mute/60">
                {field.key}
              </dt>
              <dd className="min-w-0 truncate font-mono text-[10px] text-mute">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {body && (
        <div className={cn(description || facts.length ? 'mt-4 border-t border-line/60 pt-4' : '')}>
          <Markdown text={body} />
        </div>
      )}
    </div>
  )
}

function NodeMeta({
  meta,
  now,
  className,
}: {
  meta: LearningNode | null
  now: number
  className?: string
}) {
  if (!meta) return null
  // A memory chunk's `category` is literally «memory» — its source file says
  // far more, and it is the only label worth a chip here.
  const isMemory = meta.kind === 'memory'
  const label = isMemory
    ? (MEMORY_SOURCE_LABEL[meta.memorySource ?? ''] ?? meta.memorySource ?? 'память')
    : meta.category
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {label && (
        <MetaChip
          className={isMemory ? '' : 'cat-tint'}
          {...(isMemory
            ? {}
            : { style: { '--cat-h': categoryHue(meta.category) } as CSSProperties })}
        >
          {isMemory ? (
            <FileText aria-hidden="true" className="size-3" />
          ) : (
            <span aria-hidden="true" className="cat-swatch size-1.5 rounded-full" />
          )}
          {label}
        </MetaChip>
      )}
      {meta.useCount > 0 && (
        <MetaChip>
          <Repeat2 aria-hidden="true" className="size-3" />
          {meta.useCount}× пригодилось
        </MetaChip>
      )}
      {meta.createdBy === 'agent' && (
        <MetaChip>
          <Bot aria-hidden="true" className="size-3" />
          создал агент
        </MetaChip>
      )}
      {meta.createdBy === 'memory' && !isMemory && <MetaChip>из памяти</MetaChip>}
      {meta.pinned && (
        <MetaChip className="border-accent/40 text-mercury">
          <Pin aria-hidden="true" className="size-3" />
          закреплено
        </MetaChip>
      )}
      <MetaChip>
        <Clock3 aria-hidden="true" className="size-3" />
        {relativeTime(meta.timestamp, now)}
      </MetaChip>
    </div>
  )
}

function MetaChip({
  children,
  className,
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      {...(style ? { style } : {})}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/50 px-2 py-0.5 text-[11px] text-mute',
        className,
      )}
    >
      {children}
    </span>
  )
}
