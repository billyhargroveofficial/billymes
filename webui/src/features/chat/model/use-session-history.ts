import {
  useEffect,
  useEffectEvent,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { ConnectionState, GatewayEvent } from '@/features/gateway'
import { chatApi, HISTORY_PAGE_SIZE } from '../api/chat-api'
import { prependHistoricalMessages, reconstructMessages } from './chat-history'
import { DEFAULT_CONTEXT_WINDOW, mergeRuntime, usageFromSession } from './chat-runtime'
import { errorMessage } from '@/shared/lib/error-message'
import type { SelectedSessions } from './event-scope'
import { parseSessionEventsSinceResult, parseSessionResumeResult } from './rpc-contracts'
import { shouldRestoreSelectedSession } from './session-selection'
import { recoverDurableReplay, replayEpochChanged } from './stream-recovery'
import type { ChatMessage, SessionInfo, SessionRuntime } from './types'

type Request = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>

type HistoryRefs = {
  selected: MutableRefObject<SelectedSessions>
  openGeneration: MutableRefObject<number>
  operationGeneration: MutableRefObject<number>
  hydratingOpen: MutableRefObject<number | null>
  bufferedEvents: MutableRefObject<GatewayEvent[]>
  historyPageOffset: MutableRefObject<number>
  historyUserTurnOffset: MutableRefObject<number>
  historyHasEarlier: MutableRefObject<boolean>
  historyPageLoading: MutableRefObject<boolean>
  eventWatermarks: MutableRefObject<Map<string, number>>
  recoveryEpoch: MutableRefObject<string | null>
  epochResetPending: MutableRefObject<boolean>
  restoreAttempted: MutableRefObject<boolean>
}

type UseSessionHistoryOptions = {
  profile: string
  connectionState: ConnectionState
  request: Request
  sessions: readonly SessionInfo[]
  contextWindow: number
  refs: HistoryRefs
  selectSessions: (live: string | null, history: string | null) => void
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setRuntime: Dispatch<SetStateAction<SessionRuntime>>
  setHistoryReady: Dispatch<SetStateAction<boolean>>
  setEarlierHistoryAvailable: (available: boolean) => void
  setLoadingEarlierMessages: Dispatch<SetStateAction<boolean>>
  handleGatewayEvent: (event: GatewayEvent) => void
  loadPresentation: (storedSessionId: string) => Promise<void>
  mergeCachedPresentation: (messages: ChatMessage[], storedSessionId: string) => ChatMessage[]
  makeSystemMessage: (message: string) => ChatMessage
}

/**
 * Opens durable sessions and owns paged transcript hydration. Live gateway
 * events are buffered by the caller while this hook reconciles REST history,
 * resume and replay into one ordered stream.
 */
export function useSessionHistory({
  profile,
  connectionState,
  request,
  sessions,
  contextWindow,
  refs: optionsRefs,
  selectSessions,
  setMessages,
  setBusy,
  setRuntime,
  setHistoryReady,
  setEarlierHistoryAvailable,
  setLoadingEarlierMessages,
  handleGatewayEvent,
  loadPresentation,
  mergeCachedPresentation,
  makeSystemMessage,
}: UseSessionHistoryOptions) {
  const controllerRef = useRef<HistoryRefs | null>(null)
  if (controllerRef.current === null) controllerRef.current = optionsRefs
  const {
    selected: selectedRef,
    openGeneration,
    operationGeneration,
    hydratingOpen,
    bufferedEvents,
    historyPageOffset,
    historyUserTurnOffset,
    historyHasEarlier,
    historyPageLoading,
    eventWatermarks,
    recoveryEpoch,
    epochResetPending,
    restoreAttempted,
  } = controllerRef.current

  async function openSession(id: string) {
    const generation = ++openGeneration.current
    operationGeneration.current += 1
    selectSessions(id, id)
    hydratingOpen.current = generation
    bufferedEvents.current = []
    historyPageOffset.current = 0
    historyUserTurnOffset.current = 0
    setEarlierHistoryAvailable(false)
    setMessages([])
    setBusy(false)
    setHistoryReady(false)
    try {
      const data = await chatApi.messages(id, profile, { limit: HISTORY_PAGE_SIZE, offset: 0 })
      if (generation !== openGeneration.current) return
      setMessages(reconstructMessages(data.messages))
      historyPageOffset.current = data.pagination.offset + data.pagination.returned
      historyUserTurnOffset.current = data.pagination.user_turn_offset
      setEarlierHistoryAvailable(data.pagination.returned >= data.pagination.limit)

      const applySession = (detail: SessionInfo) => {
        if (generation !== openGeneration.current) return
        setRuntime((previous) => ({
          ...previous,
          model: detail.model || previous.model,
          provider: detail.billing_provider || previous.provider,
          usage: usageFromSession(detail, contextWindow || DEFAULT_CONTEXT_WINDOW),
          sessionStartedAt: detail.started_at,
          turnStartedAt: null,
          contextWindow: contextWindow || DEFAULT_CONTEXT_WINDOW,
        }))
      }
      const row = sessions.find((session) => session.id === id)
      if (row) applySession(row)

      // Do not expose a sendable session until both asynchronous hydration
      // branches have settled. Otherwise a prompt can be added while detail
      // or resume is still pending, and a late result can replace its state.
      const [detailResult, resumeResult] = await Promise.allSettled([
        chatApi.detail(id, profile),
        request('session.resume', { session_id: id, profile, omit_messages: true }),
      ])
      if (generation !== openGeneration.current) return

      let replayWatermark: { sessionId: string; cursor: number; latestSeq: number } | null = null
      let replayEvents: GatewayEvent[] = []
      if (detailResult.status === 'fulfilled') applySession(detailResult.value)
      if (resumeResult.status === 'fulfilled') {
        try {
          const resumed = parseSessionResumeResult(resumeResult.value)
          if (resumed.session_id)
            selectSessions(resumed.session_id, resumed.stored_session_id ?? id)
          if (resumed.info) {
            setRuntime((previous) =>
              mergeRuntime(previous, { type: 'session.info', payload: resumed.info }),
            )
          }
          if (resumed.running != null) {
            setBusy(resumed.running)
            setRuntime((previous) => ({
              ...previous,
              turnStartedAt: resumed.running
                ? (resumed.turn_started_at ?? previous.turnStartedAt ?? Date.now() / 1000)
                : null,
            }))
          }
          if (resumed.session_id) {
            try {
              const lastSeen = eventWatermarks.current.get(resumed.session_id) ?? 0
              const replay = parseSessionEventsSinceResult(
                await request('session.events.since', {
                  session_id: resumed.session_id,
                  last_seen: lastSeen,
                }),
              )
              const epochChanged =
                epochResetPending.current || replayEpochChanged(recoveryEpoch.current, replay.epoch)
              if (replay.epoch) recoveryEpoch.current = replay.epoch
              epochResetPending.current = false
              if (epochChanged) eventWatermarks.current.clear()
              const recoveryLastSeen = epochChanged ? 0 : lastSeen
              const refreshHistory = async () => {
                const refreshed = await chatApi.messages(resumed.stored_session_id ?? id, profile, {
                  limit: HISTORY_PAGE_SIZE,
                  offset: 0,
                })
                if (generation !== openGeneration.current) return
                setMessages(reconstructMessages(refreshed.messages))
                historyPageOffset.current =
                  refreshed.pagination.offset + refreshed.pagination.returned
                historyUserTurnOffset.current = refreshed.pagination.user_turn_offset
                setEarlierHistoryAvailable(
                  refreshed.pagination.returned >= refreshed.pagination.limit,
                )
              }
              const recovered = await recoverDurableReplay({
                initial: replay,
                lastSeen: recoveryLastSeen,
                forceRefresh: epochChanged,
                requestSince: async (cursor) =>
                  parseSessionEventsSinceResult(
                    await request('session.events.since', {
                      session_id: resumed.session_id!,
                      last_seen: cursor,
                    }),
                  ),
                refreshHistory,
              })
              replayEvents = recovered.events
              replayWatermark = {
                sessionId: resumed.session_id,
                cursor: recovered.cursor,
                latestSeq: recovered.latestSeq,
              }
            } catch {
              // Event replay is an optional compatibility endpoint; buffered
              // live events still hydrate this session below.
            }
          }
        } catch (error) {
          setMessages((current) => [
            ...current,
            makeSystemMessage(errorMessage(error, 'некорректный ответ session.resume')),
          ])
        }
      }
      if (hydratingOpen.current === generation) {
        hydratingOpen.current = null
        const pendingLiveEvents = bufferedEvents.current
        bufferedEvents.current = []
        if (replayWatermark) {
          eventWatermarks.current.set(
            replayWatermark.sessionId,
            Math.max(
              eventWatermarks.current.get(replayWatermark.sessionId) ?? 0,
              replayWatermark.cursor,
            ),
          )
        }
        for (const event of replayEvents) handleGatewayEvent(event)
        // Events delivered by the new socket during hydration are not replay:
        // apply them after the durable replay cursor and let seq watermarks
        // collapse any overlap with `session.events.since` exactly once.
        for (const event of pendingLiveEvents) handleGatewayEvent(event)
        if (replayWatermark) {
          eventWatermarks.current.set(
            replayWatermark.sessionId,
            Math.max(
              eventWatermarks.current.get(replayWatermark.sessionId) ?? 0,
              replayWatermark.latestSeq,
            ),
          )
        }
      }
      void loadPresentation(selectedRef.current.history ?? id)
      setHistoryReady(true)
    } catch (error) {
      if (generation !== openGeneration.current) return
      if (hydratingOpen.current === generation) hydratingOpen.current = null
      selectSessions(null, null)
      setHistoryReady(true)
      setMessages((current) => [
        ...current,
        makeSystemMessage(error instanceof Error ? error.message : 'session open failed'),
      ])
    }
  }

  async function loadEarlierMessages() {
    const storedSessionId = selectedRef.current.history
    if (!storedSessionId || !historyHasEarlier.current || historyPageLoading.current) {
      return 0
    }
    const generation = openGeneration.current
    const offset = historyPageOffset.current
    historyPageLoading.current = true
    setLoadingEarlierMessages(true)
    try {
      const page = await chatApi.messages(storedSessionId, profile, {
        limit: HISTORY_PAGE_SIZE,
        offset,
      })
      if (generation !== openGeneration.current || selectedRef.current.history !== storedSessionId)
        return 0

      const older = reconstructMessages(page.messages)
      historyPageOffset.current = page.pagination.offset + page.pagination.returned
      historyUserTurnOffset.current = page.pagination.user_turn_offset
      setMessages((current) =>
        mergeCachedPresentation(prependHistoricalMessages(current, older), storedSessionId),
      )
      setEarlierHistoryAvailable(page.pagination.returned >= page.pagination.limit)
      // React may defer the state updater, so report the page's visible row
      // count rather than deriving it from the updater side effect. The merge
      // itself still removes overlapping stable local IDs.
      return older.length
    } catch (error) {
      if (
        generation === openGeneration.current &&
        selectedRef.current.history === storedSessionId
      ) {
        setMessages((current) => [
          ...current,
          makeSystemMessage(errorMessage(error, 'не удалось загрузить ранние сообщения')),
        ])
      }
      // Keep hasEarlier intact: a transient request failure must remain
      // retryable and must not strand the scroll anchor in the caller.
      return 0
    } finally {
      historyPageLoading.current = false
      setLoadingEarlierMessages(false)
    }
  }

  const restoreSession = useEffectEvent((storedSessionId: string) => {
    void openSession(storedSessionId)
  })

  const restorePersistedSession = useEffectEvent(() => {
    const storedSessionId = selectedRef.current.history
    if (!storedSessionId) return
    if (!shouldRestoreSelectedSession(connectionState, storedSessionId, restoreAttempted.current)) {
      return
    }
    restoreAttempted.current = true
    restoreSession(storedSessionId)
  })

  useEffect(() => {
    restorePersistedSession()
  }, [connectionState])

  return { openSession, loadEarlierMessages }
}
