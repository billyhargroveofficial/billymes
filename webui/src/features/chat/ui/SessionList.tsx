import { useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  CheckCircle2,
  Circle,
  ListChecks,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react'
import { memo, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Notice } from '@/shared/ui/notice'
import { StaggerItem } from '@/shared/ui/motion'
import { Skeleton, SkeletonBlock } from '@/shared/ui/skeleton'
import { chatApi } from '../api/chat-api'
import { relTime } from '../model/format'
import {
  batchDeleteableSessionIds,
  groupSessions,
  isSessionPlaying,
  sessionTurns,
} from '../model/session-utils'
import type { SessionInfo } from '../model/types'

const SEARCH_THRESHOLD = 8

export const SessionList = memo(function SessionList({
  sessions,
  loading = false,
  activeId,
  playingId,
  profile,
  onOpen,
  onNew,
}: {
  sessions: SessionInfo[]
  loading?: boolean
  activeId: string | null
  playingId: string | null
  profile: string
  onOpen: (id: string) => void
  /** When set, the list renders its own «сессии · выбрать · новая» header. */
  onNew?: () => void
}) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const cancelBlurCommit = useRef(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState<'archive' | 'delete' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return sessions
    return sessions.filter((session) =>
      (session.title || session.id).toLowerCase().includes(needle),
    )
  }, [sessions, query])
  const groups = groupSessions(filtered)
  const deletableSelectedCount = batchDeleteableSessionIds(selected, activeId, playingId).length

  function scopeProfile() {
    return profile === 'default' ? undefined : profile
  }

  async function mutate(id: string, body: { title?: string; pinned?: boolean }) {
    setActionError(null)
    const key = ['sessions', profile] as const
    queryClient.setQueryData(key, (old: { sessions: SessionInfo[]; total: number } | undefined) => {
      if (!old) return old
      return {
        ...old,
        sessions: old.sessions.map((session) =>
          session.id === id ? { ...session, ...body } : session,
        ),
      }
    })
    try {
      const scoped = scopeProfile()
      await chatApi.patch(id, { ...body, ...(scoped ? { profile: scoped } : {}) }, profile)
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: key })
      setActionError(errorMessage(error, 'не удалось изменить сессию'))
      throw error
    }
    await queryClient.invalidateQueries({ queryKey: key })
  }

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setConfirmDelete(false)
  }

  function leaveSelectMode() {
    setSelecting(false)
    setSelected(new Set())
    setConfirmDelete(false)
  }

  async function runBatch(action: 'archive' | 'delete') {
    if (action === 'delete' && !confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setActionError(null)
    const ids =
      action === 'delete' ? batchDeleteableSessionIds(selected, activeId, playingId) : [...selected]
    if (!ids.length) {
      setActionError('активную или выполняющуюся сессию нельзя удалить')
      setConfirmDelete(false)
      return
    }
    setBatchBusy(action)
    try {
      for (const id of ids) {
        if (action === 'archive') {
          const scoped = scopeProfile()
          await chatApi.patch(
            id,
            { archived: true, ...(scoped ? { profile: scoped } : {}) },
            profile,
          )
        } else {
          await chatApi.remove(id, scopeProfile())
        }
      }
      leaveSelectMode()
    } catch (error) {
      setActionError(
        errorMessage(
          error,
          action === 'archive' ? 'не удалось заархивировать сессии' : 'не удалось удалить сессии',
        ),
      )
    } finally {
      setBatchBusy(null)
      setConfirmDelete(false)
      await queryClient.invalidateQueries({ queryKey: ['sessions', profile] })
    }
  }

  async function commitRename(id: string) {
    if (cancelBlurCommit.current) {
      cancelBlurCommit.current = false
      return
    }
    const next = draftTitle.trim()
    setEditingId(null)
    if (!next) return
    await mutate(id, { title: next })
  }

  if (loading && !sessions.length) return <SessionListSkeleton />

  const groupStart = (index: number) =>
    groups.slice(0, index).reduce((total, group) => total + group.items.length, 0)

  const selectToggle = sessions.length > 0 && (
    <button
      type="button"
      aria-label={selecting ? 'закончить выбор' : 'выбрать сессии'}
      title={selecting ? 'готово' : 'выбрать'}
      aria-pressed={selecting}
      onClick={() => (selecting ? leaveSelectMode() : setSelecting(true))}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-lg text-mute transition-colors hover:bg-raised hover:text-paper',
        selecting && 'bg-accent text-accent-ink hover:bg-accent hover:text-accent-ink',
      )}
    >
      <ListChecks aria-hidden="true" className="size-3.5" />
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {onNew ? (
        <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-mute">сессии</div>
          <span className="flex items-center gap-1">
            {selectToggle}
            <Button size="sm" variant="ghost" onClick={onNew}>
              <Plus className="size-3.5" /> новая
            </Button>
          </span>
        </div>
      ) : (
        sessions.length > 0 && (
          <div className="flex shrink-0 items-center justify-end px-3 pb-1">{selectToggle}</div>
        )
      )}
      {sessions.length > SEARCH_THRESHOLD && (
        <div className="shrink-0 px-3 pb-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute"
            />
            <input
              type="search"
              name="session-search"
              autoComplete="off"
              aria-label="поиск по сессиям"
              placeholder="найти сессию…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-full rounded-lg border border-line/70 bg-ink/40 pl-8 pr-2 text-xs text-paper transition-colors placeholder:text-mute/70 focus:border-line"
            />
          </div>
        </div>
      )}
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {actionError && <Notice className="px-2 pb-2">{actionError}</Notice>}
        {groups.map((group, groupIndex) => (
          <section
            key={group.key}
            className="mb-2.5 rounded-2xl border border-line/50 bg-panel/40 p-1.5"
          >
            <div className="flex items-baseline gap-1.5 px-1.5 pb-1.5 pt-0.5 text-[10px] uppercase tracking-[0.16em] text-mute">
              {group.label}
              <span className="font-mono tracking-normal text-mute/60">{group.items.length}</span>
            </div>
            {group.items.map((session, itemIndex) => {
              const playing = isSessionPlaying(session.id, playingId)
              const editing = editingId === session.id
              return (
                <StaggerItem key={session.id} index={groupStart(groupIndex) + itemIndex}>
                  <div
                    data-selected={activeId === session.id}
                    className={cn(
                      'row-interactive group relative mb-0.5 rounded-xl px-2 py-1.5',
                      playing && 'session-live',
                    )}
                  >
                    {editing ? (
                      <input
                        autoFocus
                        name="session-title"
                        autoComplete="off"
                        aria-label="название сессии"
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') {
                            cancelBlurCommit.current = true
                            setEditingId(null)
                            event.currentTarget.blur()
                          }
                        }}
                        onBlur={() => void commitRename(session.id).catch(() => undefined)}
                        className="relative z-10 h-7 w-full rounded-md border border-line bg-ink px-2 text-xs text-paper"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          className="relative z-10 block w-full min-w-0 text-left"
                          onClick={() =>
                            selecting ? toggleSelected(session.id) : onOpen(session.id)
                          }
                        >
                          <span className="flex items-center gap-1.5">
                            <span className="select-slot shrink-0" data-open={selecting}>
                              {selected.has(session.id) ? (
                                <CheckCircle2
                                  aria-hidden="true"
                                  className="select-pop size-3.5 shrink-0 text-accent"
                                />
                              ) : (
                                <Circle
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0 text-mute/50"
                                />
                              )}
                            </span>
                            {playing && (
                              <span className="pulse-soft size-1.5 shrink-0 rounded-full bg-accent" />
                            )}
                            {session.pinned && (
                              <Pin
                                aria-hidden="true"
                                className="size-2.5 shrink-0 fill-current text-mute"
                              />
                            )}
                            <span className="truncate text-[13px] leading-5">
                              {session.title || session.id}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 text-[10px] tracking-wide text-mute">
                            <span className="truncate">{session.source || 'cli'}</span>
                            <span
                              className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
                              title={`ходов: ${session.turn_count ?? sessionTurns(session.message_count)}`}
                            >
                              <MessageSquare aria-hidden="true" className="size-2.5" />
                              {session.turn_count ?? sessionTurns(session.message_count)}
                            </span>
                            <span
                              className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
                              title={`вызовов инструментов: ${session.display_tool_call_count ?? session.tool_call_count}`}
                            >
                              <Wrench aria-hidden="true" className="size-2.5" />
                              {session.display_tool_call_count ?? session.tool_call_count}
                            </span>
                            <span className="ml-auto shrink-0 pl-2 font-mono tabular-nums text-mute/80">
                              {relTime(session.last_activity_at || session.last_active)}
                            </span>
                          </span>
                        </button>
                        <div
                          className={cn(
                            'absolute inset-y-0 right-1 z-10 flex items-center gap-0.5 rounded-lg opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:group-data-[selected=true]:opacity-100',
                            selecting && 'hidden',
                          )}
                        >
                          <RowAction
                            label={session.pinned ? 'открепить сессию' : 'закрепить сессию'}
                            title={session.pinned ? 'открепить' : 'закрепить'}
                            active={Boolean(session.pinned)}
                            onClick={() =>
                              void mutate(session.id, { pinned: !session.pinned }).catch(
                                () => undefined,
                              )
                            }
                          >
                            <Pin className={cn('size-3', session.pinned && 'fill-current')} />
                          </RowAction>
                          <RowAction
                            label="переименовать сессию"
                            title="переименовать"
                            onClick={() => {
                              cancelBlurCommit.current = false
                              setEditingId(session.id)
                              setDraftTitle(session.title || '')
                            }}
                          >
                            <Pencil className="size-3" />
                          </RowAction>
                        </div>
                      </>
                    )}
                  </div>
                </StaggerItem>
              )
            })}
          </section>
        ))}
        {!filtered.length && (
          <p className="px-3 pt-2 text-sm text-mute">
            {query ? 'ничего не нашлось' : 'пока пусто'}
          </p>
        )}
        {selecting && (
          <div className="select-bar sticky bottom-0 z-10 mt-2 flex items-center gap-1.5 rounded-xl border border-line bg-panel/95 px-2 py-1.5 shadow-lift backdrop-blur">
            <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-mute">
              {selected.size} выбрано
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={selected.size === 0 || batchBusy !== null}
              onClick={() => void runBatch('archive')}
            >
              <Archive aria-hidden="true" className="size-3.5" />
              {batchBusy === 'archive' ? 'архивируем…' : 'в архив'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={confirmDelete ? 'ember' : 'ghost'}
              disabled={deletableSelectedCount === 0 || batchBusy !== null}
              onClick={() => void runBatch('delete')}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              {batchBusy === 'delete' ? 'удаляем…' : confirmDelete ? 'точно удалить?' : 'удалить'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
})

function RowAction({
  label,
  title,
  active = false,
  onClick,
  children,
}: {
  label: string
  title: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'grid size-6.5 place-items-center rounded-md border border-line/60 bg-panel/90 text-mute shadow-lift backdrop-blur transition-colors hover:bg-raised hover:text-paper',
        active && 'text-mercury',
      )}
    >
      {children}
    </button>
  )
}

function SessionListSkeleton() {
  return (
    <SkeletonBlock label="загружаем сессии" className="min-h-0 flex-1 space-y-3 px-2 pb-4">
      {[0, 1, 2].map((group) => (
        <div key={group} className="space-y-1">
          <Skeleton className="mb-1.5 ml-2 h-2 w-16" />
          {Array.from({ length: 4 - group }, (_, row) => (
            <div key={row} className="space-y-1 rounded-xl px-1.5 py-1">
              <Skeleton className="h-3" style={{ width: `${82 - row * 11}%` }} />
              <Skeleton className="h-2" style={{ width: `${46 - row * 6}%` }} />
            </div>
          ))}
        </div>
      ))}
    </SkeletonBlock>
  )
}
