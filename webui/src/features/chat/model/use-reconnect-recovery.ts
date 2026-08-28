import {
  useEffect,
  useEffectEvent,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { ConnectionState, GatewayEvent } from '@/features/gateway'
import { chatApi } from '../api/chat-api'
import {
  reconstructActiveReplayHistory,
  reconstructMessages,
  resolveReplayHistoryPaging,
} from './chat-history'
import { mergeRuntime } from './chat-runtime'
import { parseSessionEventsSinceResult, parseSessionResumeResult } from './rpc-contracts'
import { recoverDurableReplay, ReplayRecoveryBuffer, replayEpochChanged } from './stream-recovery'
import type { SelectedSessions } from './event-scope'
import type { ChatMessage, SessionRuntime } from './types'

type Request = (method: string, params?: Record<string, unknown>) => Promise<unknown>

type Options = {
  profile: string
  connectionGeneration: number
  connectionState: ConnectionState
  request: Request
  selected: MutableRefObject<SelectedSessions>
  reconnectSeen: MutableRefObject<boolean>
  recoveryEpoch: MutableRefObject<string | null>
  epochResetPending: MutableRefObject<boolean>
  eventWatermarks: MutableRefObject<Map<string, number>>
  recoveryBuffer: MutableRefObject<ReplayRecoveryBuffer>
  historyPageOffset: MutableRefObject<number>
  historyUserTurnOffset: MutableRefObject<number>
  historyThroughDisplayKey: MutableRefObject<string | null>
  selectSessions: (live: string | null, history: string | null) => void
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setRuntime: Dispatch<SetStateAction<SessionRuntime>>
  setEarlierHistoryAvailable: (value: boolean) => void
  applyEvent: (event: GatewayEvent) => void
  loadPresentation: (sessionId: string) => Promise<void>
}

export function useReconnectRecovery(options: Options) {
  const latest = useEffectEvent(() => options)
  const selectRecoveredSession = useEffectEvent(options.selectSessions)
  const applyRecoveredEvent = useEffectEvent(options.applyEvent)
  const loadRecoveredPresentation = useEffectEvent(options.loadPresentation)
  useEffect(() => {
    const current = latest()
    if (!current.connectionGeneration || current.connectionState !== 'open') return
    const alreadyConnected = current.reconnectSeen.current
    current.reconnectSeen.current = true
    const storedSessionId = current.selected.current.history
    if (!alreadyConnected || !storedSessionId) return
    let disposed = false
    const recover = async () => {
      const state = latest()
      let token: number | null = null
      const take = () => (token == null ? [] : state.recoveryBuffer.current.take(token))
      try {
        const resumed = parseSessionResumeResult(
          await state.request('session.resume', {
            session_id: storedSessionId,
            profile: state.profile,
            omit_messages: true,
          }),
        )
        if (disposed || state.selected.current.history !== storedSessionId || !resumed.session_id)
          return
        const durableId = resumed.stored_session_id ?? storedSessionId
        selectRecoveredSession(resumed.session_id, durableId)
        if (resumed.info)
          state.setRuntime((previous) =>
            mergeRuntime(previous, { type: 'session.info', payload: resumed.info }),
          )
        if (resumed.running != null) {
          state.setBusy(resumed.running)
          state.setRuntime((previous) => ({
            ...previous,
            turnStartedAt: resumed.running
              ? (resumed.turn_started_at ?? previous.turnStartedAt ?? Date.now() / 1000)
              : null,
          }))
        }
        const lastSeen = state.eventWatermarks.current.get(resumed.session_id) ?? 0
        token = state.recoveryBuffer.current.begin(resumed.session_id)
        const replay = parseSessionEventsSinceResult(
          await state.request('session.events.since', {
            session_id: resumed.session_id,
            last_seen: lastSeen,
          }),
        )
        if (disposed || state.selected.current.history !== durableId) {
          take()
          return
        }
        const epochChanged =
          state.epochResetPending.current ||
          replayEpochChanged(state.recoveryEpoch.current, replay.epoch)
        if (replay.epoch) state.recoveryEpoch.current = replay.epoch
        state.epochResetPending.current = false
        if (epochChanged) state.eventWatermarks.current.clear()
        const recovered = await recoverDurableReplay({
          initial: replay,
          lastSeen: epochChanged ? 0 : lastSeen,
          forceRefresh: epochChanged,
          initialActiveTurn: resumed.running === true,
          requestSince: async (cursor) =>
            parseSessionEventsSinceResult(
              await state.request('session.events.since', {
                session_id: resumed.session_id!,
                last_seen: cursor,
              }),
            ),
          refreshHistory: async ({ omitActiveReplayTail: omitTail }) => {
            const throughDisplayKey =
              omitTail && typeof resumed.inflight?.history_anchor_display_key === 'string'
                ? resumed.inflight.history_anchor_display_key
                : undefined
            const history = await chatApi.messages(durableId, state.profile, {
              ...(throughDisplayKey ? { throughDisplayKey } : {}),
            })
            if (disposed || state.selected.current.history !== durableId) return
            const paging = resolveReplayHistoryPaging(history.pagination, {
              omitActiveReplayTail: omitTail,
              historyAnchorDisplayKey: resumed.inflight?.history_anchor_display_key,
              throughDisplayKeyFound: history.pagination.through_display_key_found === true,
            })
            state.historyPageOffset.current = paging.pageOffset
            state.historyUserTurnOffset.current = paging.userTurnOffset
            state.historyThroughDisplayKey.current = paging.throughDisplayKey
            state.setEarlierHistoryAvailable(paging.hasEarlier)
            state.setMessages(
              omitTail
                ? reconstructActiveReplayHistory(history.messages, {
                    historyAnchorDisplayKey: resumed.inflight?.history_anchor_display_key,
                    throughDisplayKeyFound: history.pagination.through_display_key_found === true,
                    inflightUser: resumed.inflight?.user ?? null,
                    turnStartedAt: resumed.turn_started_at,
                  })
                : reconstructMessages(history.messages),
            )
          },
        })
        if (disposed || state.selected.current.history !== durableId) {
          take()
          return
        }
        state.setBusy(recovered.activeTurn)
        state.setRuntime((previous) => ({
          ...previous,
          turnStartedAt: recovered.activeTurn
            ? (resumed.turn_started_at ?? previous.turnStartedAt ?? Date.now() / 1000)
            : null,
        }))
        const pending = take()
        state.eventWatermarks.current.set(
          resumed.session_id,
          Math.max(state.eventWatermarks.current.get(resumed.session_id) ?? 0, recovered.cursor),
        )
        for (const event of [...recovered.events, ...pending]) applyRecoveredEvent(event)
        state.eventWatermarks.current.set(
          resumed.session_id,
          Math.max(state.eventWatermarks.current.get(resumed.session_id) ?? 0, recovered.latestSeq),
        )
        void loadRecoveredPresentation(durableId)
      } catch {
        for (const event of take()) applyRecoveredEvent(event)
      }
    }
    void recover()
    return () => {
      disposed = true
    }
  }, [options.connectionGeneration, options.connectionState, options.profile, options.request])
}
