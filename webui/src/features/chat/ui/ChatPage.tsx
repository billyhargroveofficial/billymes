import { AnimatePresence } from 'motion/react'
import { ArrowDown, ChevronUp, List, PanelRight, Plus } from 'lucide-react'
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useProfileScope } from '@/features/profiles'
import { Button } from '@/shared/ui/button'
import { m } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { Sheet } from '@/shared/ui/sheet'
import { dayLabel } from '../model/format'
import { recentTodos } from '../model/todo-utils'
import { useAttachments } from '../model/use-attachments'
import { useChatScroll } from '../model/use-chat-scroll'
import { useChatRuntime } from '../model/use-chat-runtime'
import type { ChatMessage } from '../model/types'
import { Composer } from './Composer'
import { EmptyState } from './EmptyState'
import { Inspector } from './Inspector'
import { MessageRow } from './MessageRow'

const SessionList = lazy(async () => {
  const feature = await import('./SessionList')
  return { default: feature.SessionList }
})

const THREAD_WINDOW = 80
const THREAD_WINDOW_STEP = 160

const JUMP_ENTER = { opacity: 0, scale: 0.8, y: 8 }
const JUMP_SETTLED = { opacity: 1, scale: 1, y: 0 }
const JUMP_EXIT = { opacity: 0, scale: 0.85, y: 6 }

type ThreadItem =
  | { kind: 'separator'; key: string; label: string }
  | { kind: 'message'; message: ChatMessage; withHeader: boolean }

function buildThreadItems(messages: ChatMessage[]): ThreadItem[] {
  const items: ThreadItem[] = []
  let previousDay = ''
  let previousRole = ''
  for (const message of messages) {
    const day = dayLabel(message.timestamp)
    if (day && day !== previousDay) {
      items.push({ kind: 'separator', key: `day:${day}`, label: day })
      previousDay = day
    }
    items.push({
      kind: 'message',
      message,
      withHeader: message.role === 'assistant' && previousRole !== 'assistant',
    })
    previousRole = message.role
  }
  return items
}

/**
 * «Прошлый ход» for a freshly opened session: from the last user message to
 * the newest assistant timestamp that answered it. Live turns overwrite this
 * with the exact wall-clock measure kept by the runtime.
 */
function lastTurnFromHistory(messages: ChatMessage[]): number | null {
  const seconds = (value: number) => (value > 1e12 ? value / 1000 : value)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (!candidate || candidate.role !== 'user') continue
    if (!candidate.timestamp) return null
    let end = 0
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const reply = messages[cursor]
      if (reply && reply.role === 'assistant' && reply.timestamp) {
        end = Math.max(end, reply.timestamp)
      }
    }
    if (!end) return null
    return Math.max(0, seconds(end) - seconds(candidate.timestamp))
  }
  return null
}

export function ChatPage() {
  const { profile, status } = useProfileScope()
  const chat = useChatRuntime()
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [inspectOpen, setInspectOpen] = useState(false)
  const sessionKey = chat.historySessionId || chat.sessionId || `__draft:${profile}`
  const { containerRef, onScroll, pin, showJump } = useChatScroll(
    sessionKey,
    chat.messages,
    chat.historyReady,
    chat.busy,
  )

  const threadEl = useRef<HTMLDivElement | null>(null)
  const setThreadRefs = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef(element)
      threadEl.current = element
    },
    [containerRef],
  )

  const [visibleCount, setVisibleCount] = useState(THREAD_WINDOW)
  const [windowKey, setWindowKey] = useState(sessionKey)
  const expandAnchor = useRef<{ height: number; top: number } | null>(null)
  if (windowKey !== sessionKey) {
    setWindowKey(sessionKey)
    setVisibleCount(THREAD_WINDOW)
  }
  const hiddenCount = Math.max(0, chat.messages.length - visibleCount)
  const loadEarlierMessages = chat.loadEarlierMessages
  const revealOlder = useCallback(async () => {
    const el = threadEl.current
    if (el) expandAnchor.current = { height: el.scrollHeight, top: el.scrollTop }
    if (hiddenCount > 0) {
      setVisibleCount((count) => count + THREAD_WINDOW_STEP)
      return
    }
    const added = await loadEarlierMessages()
    if (added) setVisibleCount((count) => count + added)
    else expandAnchor.current = null
  }, [hiddenCount, loadEarlierMessages])
  useLayoutEffect(() => {
    const el = threadEl.current
    const anchor = expandAnchor.current
    if (!el || !anchor) return
    expandAnchor.current = null
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
  }, [visibleCount])

  const threadItems = useMemo(
    () => buildThreadItems(hiddenCount ? chat.messages.slice(hiddenCount) : chat.messages),
    [chat.messages, hiddenCount],
  )

  const openSession = chat.openSession
  const handleOpenSession = useCallback(
    (id: string) => {
      void openSession(id)
    },
    [openSession],
  )
  const handleOpenSessionFromSheet = useCallback(
    (id: string) => {
      void openSession(id)
      setSessionsOpen(false)
    },
    [openSession],
  )
  const setDraft = chat.setDraft
  const handleOpener = useCallback(
    (text: string) => {
      setDraft(text)
      document.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus()
    },
    [setDraft],
  )
  const setDialogReasoning = chat.setDialogReasoning
  const handleReasoning = useCallback(
    (level: string) => {
      void setDialogReasoning(level)
    },
    [setDialogReasoning],
  )
  const setDialogModel = chat.setDialogModel
  const handleModel = useCallback(
    (provider: string, model: string) => {
      void setDialogModel(provider, model)
    },
    [setDialogModel],
  )
  const attachments = useAttachments(profile)
  const attachmentMarkers = attachments.markers
  const attachmentsClear = attachments.clear
  const attachmentsAdd = attachments.addFiles
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)
  const handleAttach = useCallback(
    (files: File[]) => {
      attachmentsAdd(files)
    },
    [attachmentsAdd],
  )

  const send = chat.send
  const stop = chat.stop
  const handleSend = useCallback(async () => {
    pin()
    if (await send(attachmentMarkers())) attachmentsClear()
  }, [pin, send, attachmentMarkers, attachmentsClear])
  const handleStop = useCallback(() => {
    void stop()
  }, [stop])

  const allTools = useMemo(() => chat.messages.flatMap((message) => message.tools), [chat.messages])
  const todos = useMemo(() => recentTodos(chat.messages), [chat.messages])
  const subagents = useMemo(
    () => chat.messages.flatMap((message) => message.subagents),
    [chat.messages],
  )
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const tool of allTools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1)
    return [...counts.entries()].sort((left, right) => right[1] - left[1])
  }, [allTools])
  const runningTools = useMemo(
    () => allTools.filter((tool) => tool.status === 'running').length,
    [allTools],
  )
  const activeSession = useMemo(
    () => chat.sessions.find((session) => session.id === chat.historySessionId) ?? null,
    [chat.sessions, chat.historySessionId],
  )
  const lastTurnFallback = useMemo(() => lastTurnFromHistory(chat.messages), [chat.messages])

  const inspector = (
    <Inspector
      todos={todos}
      tools={allTools.length}
      runningTools={runningTools}
      toolCounts={toolCounts}
      subagents={subagents.length}
      sessions={chat.sessions}
      activeId={chat.historySessionId}
      playingId={chat.busy ? chat.historySessionId : null}
      profile={profile}
      onOpen={handleOpenSession}
      {...(status ? { platforms: status.gateway_platforms } : {})}
      runtime={chat.runtime}
    />
  )

  return (
    <div className="flex min-h-0 flex-1">
      <h1 className="sr-only">Чаты</h1>
      <section className="hidden min-h-0 w-72 shrink-0 flex-col border-r border-line/70 bg-panel/40 lg:flex">
        <Suspense fallback={<SessionListFallback />}>
          <SessionList
            sessions={chat.sessions}
            loading={chat.sessionsLoading}
            activeId={chat.historySessionId}
            playingId={chat.busy ? chat.historySessionId : null}
            profile={profile}
            onOpen={handleOpenSession}
            onNew={chat.newChat}
          />
        </Suspense>
      </section>

      <section
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        onDragEnter={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          setDropActive(true)
        }}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return
          event.preventDefault()
        }}
        onDragLeave={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDropActive(false)
        }}
        onDrop={(event) => {
          if (![...event.dataTransfer.types].includes('Files')) return
          event.preventDefault()
          dragDepth.current = 0
          setDropActive(false)
          const files = [...event.dataTransfer.files]
          if (files.length) handleAttach(files)
        }}
      >
        {dropActive && (
          <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-3xl border-2 border-dashed border-accent/60 bg-ink/70 backdrop-blur-sm">
            <div className="text-center">
              <div className="font-display text-2xl italic text-mercury">бросай сюда</div>
              <div className="mt-1 text-xs text-mute">файлы прикрепятся к депеше</div>
            </div>
          </div>
        )}
        {chat.loadError && <Notice className="mx-4 mt-2 md:mx-8">{chat.loadError}</Notice>}

        {/* No narrow-screen header row: chat controls float over the thread so
            the messages get the full viewport height. */}
        <div className="absolute right-2 top-2 z-30 flex gap-1.5 lg:hidden">
          <button
            type="button"
            aria-label="сессии"
            onClick={() => setSessionsOpen(true)}
            className="card-interactive grid size-10 place-items-center rounded-full border border-line bg-panel/85 text-paper shadow-lift backdrop-blur-md"
          >
            <List aria-hidden="true" className="size-[18px]" />
          </button>
          <button
            type="button"
            aria-label="новая сессия"
            onClick={chat.newChat}
            className="card-interactive grid size-10 place-items-center rounded-full border border-line bg-panel/85 text-paper shadow-lift backdrop-blur-md"
          >
            <Plus aria-hidden="true" className="size-[18px]" />
          </button>
          <button
            type="button"
            aria-label="ход работы"
            onClick={() => setInspectOpen(true)}
            className="card-interactive grid size-10 place-items-center rounded-full border border-line bg-panel/85 text-paper shadow-lift backdrop-blur-md"
          >
            <PanelRight aria-hidden="true" className="size-[18px]" />
          </button>
        </div>

        {(activeSession || chat.messages.length > 0) && (
          <div className="hidden shrink-0 items-center gap-2.5 border-b border-line/40 px-8 py-2 lg:flex">
            <span className="min-w-0 truncate font-display text-[15px] italic leading-6 text-mercury">
              {activeSession?.title || 'новая сессия'}
            </span>
            {activeSession?.source && (
              <span className="shrink-0 rounded-full border border-line/70 px-2 py-0.5 font-mono text-[10px] text-mute">
                {activeSession.source}
              </span>
            )}
            {chat.runtime.model && (
              <span className="min-w-0 truncate font-mono text-[10px] text-mute/80">
                {chat.runtime.model}
              </span>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div
            ref={setThreadRefs}
            onScroll={onScroll}
            aria-live="polite"
            className="absolute inset-0 overflow-y-auto px-4 pb-6 pt-16 md:px-8 lg:pt-4"
          >
            {chat.messages.length === 0 ? (
              <EmptyState profile={profile} onOpener={handleOpener} />
            ) : (
              <div className="mx-auto max-w-4xl space-y-3">
                {(hiddenCount > 0 || chat.hasEarlierMessages) && (
                  <div className="flex justify-center pb-1">
                    <button
                      type="button"
                      onClick={() => void revealOlder()}
                      disabled={chat.loadingEarlierMessages}
                      className="card-interactive inline-flex items-center gap-1.5 rounded-full border border-line bg-raised/70 px-3 py-1 text-[11px] text-mute hover:text-paper"
                    >
                      <ChevronUp className="size-3" />
                      {chat.loadingEarlierMessages
                        ? 'загружаем раньше…'
                        : hiddenCount > 0
                          ? `показать раньше · ${hiddenCount}`
                          : 'показать раньше'}
                    </button>
                  </div>
                )}
                {threadItems.map((item) =>
                  item.kind === 'separator' ? (
                    <div
                      key={item.key}
                      className="flex items-center gap-3 py-2 text-[10px] uppercase tracking-[0.2em] text-mute"
                    >
                      <span aria-hidden="true" className="h-px flex-1 bg-line/60" />
                      {item.label}
                      <span aria-hidden="true" className="h-px flex-1 bg-line/60" />
                    </div>
                  ) : (
                    <MessageRow
                      key={item.message.localId}
                      message={item.message}
                      withHeader={item.withHeader}
                    />
                  ),
                )}
              </div>
            )}
          </div>
          <AnimatePresence>
            {showJump && (
              <m.button
                key="jump"
                type="button"
                initial={JUMP_ENTER}
                animate={JUMP_SETTLED}
                exit={JUMP_EXIT}
                onClick={() => pin(true)}
                className="absolute bottom-4 right-4 z-10 grid size-10 place-items-center rounded-full border border-line bg-panel/95 text-paper shadow-desk backdrop-blur transition-colors hover:bg-raised"
                aria-label="вниз"
              >
                <ArrowDown className="size-4" />
              </m.button>
            )}
          </AnimatePresence>
        </div>

        <div className="composer-dock relative z-10 shrink-0 px-4 pb-2 md:px-8 md:pb-4">
          <Composer
            draft={chat.draft}
            busy={chat.busy}
            historyReady={chat.historyReady}
            connectionState={chat.connectionState}
            runtime={chat.runtime}
            reasoningSupported={chat.reasoningSupported}
            profile={profile}
            scopeKey={sessionKey}
            lastTurnFallback={lastTurnFallback}
            attachments={attachments.items}
            onAttach={handleAttach}
            onRemoveAttachment={attachments.remove}
            onDraft={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            onModel={handleModel}
            onReasoning={handleReasoning}
          />
        </div>
      </section>

      <aside className="hidden min-h-0 w-80 shrink-0 overflow-hidden border-l border-line/70 bg-panel/30 xl:block">
        {inspector}
      </aside>

      <Sheet open={sessionsOpen} onOpenChange={setSessionsOpen} side="left" title="Сессии">
        <Button size="sm" variant="outline" onClick={chat.newChat} className="mb-3">
          новая сессия
        </Button>
        <Suspense fallback={<SessionListFallback />}>
          <SessionList
            sessions={chat.sessions}
            loading={chat.sessionsLoading}
            activeId={chat.historySessionId}
            playingId={chat.busy ? chat.historySessionId : null}
            profile={profile}
            onOpen={handleOpenSessionFromSheet}
          />
        </Suspense>
      </Sheet>
      <Sheet open={inspectOpen} onOpenChange={setInspectOpen} side="bottom" title="Ход работы">
        {inspector}
      </Sheet>
    </div>
  )
}

function SessionListFallback() {
  return <div className="min-h-0 flex-1 animate-pulse" aria-label="загружаем сессии" />
}
