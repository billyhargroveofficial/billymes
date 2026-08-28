import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react'
import { type ConnectionState, type GatewayEvent, useGateway } from '@/features/gateway'
import { modelKeys, modelSelectionApi } from '@/features/model-selection'
import { useProfileScope } from '@/features/profiles'
import { combinedErrorMessage } from '@/shared/lib/error-message'
import { chatApi } from '../api/chat-api'
import { reconstructMessages } from './chat-history'
import { emptyRuntime, mergeRuntime } from './chat-runtime'
import { ChatRuntimeContext, type ChatRuntimeContextValue } from './chat-runtime-context'
import { systemMessage } from './chat-messages'
import { applyGatewayEvent } from './chat-reducer'
import { eventBelongsToSelection, type SelectedSessions } from './event-scope'
import {
  parseContextBreakdownResult,
  parseSessionEventsSinceResult,
  parseSessionPresentationListResult,
  parseSessionResumeResult,
  parseSessionUsageResult,
  type SessionPresentationCard,
} from './rpc-contracts'
import {
  mergePresentationIntoMessages,
  PresentationTerminalReconciler,
  refreshesPresentationLedger,
  runPresentationTerminalReconciliation,
} from './presentation-tools'
import { readSelectedSession, writeSelectedSession } from './session-selection'
import { mergeUsage } from './session-utils'
import { acceptGatewayEvent, replayEpochChanged } from './stream-recovery'
import type { ChatMessage, SessionInfo, SessionRuntime } from './types'
import { useChatActions } from './use-chat-actions'
import { useGatewayConnection } from './use-gateway-connection'
import { useSessionHistory } from './use-session-history'

const EMPTY_SESSIONS: SessionInfo[] = []

export function ChatRuntimeProvider({ children }: { children: ReactNode }) {
  const { profile } = useProfileScope()
  return (
    <ProfileChatRuntime key={profile} profile={profile}>
      {children}
    </ProfileChatRuntime>
  )
}

function ProfileChatRuntime({ children, profile }: { children: ReactNode; profile: string }) {
  const { profiles } = useProfileScope()
  const { epoch } = useGateway()
  const queryClient = useQueryClient()
  const currentProfile = profiles.find((item) => item.name === profile)
  const [selected, setSelectedState] = useState<SelectedSessions>({
    live: null,
    history:
      typeof window === 'undefined' ? null : readSelectedSession(window.localStorage, profile),
  })
  const selectedRef = useRef<SelectedSessions>(selected)
  const openGeneration = useRef(0)
  const operationGeneration = useRef(0)
  const stopGeneration = useRef(0)
  const reasoningConfigGeneration = useRef(0)
  const sendInFlight = useRef<number | null>(null)
  const sendNonce = useRef(0)
  const reconnectSeen = useRef(false)
  const restoreAttempted = useRef(false)
  const recoveryEpoch = useRef<string | null>(null)
  const epochResetPending = useRef(false)
  const eventWatermarks = useRef(new Map<string, number>())
  const hydratingOpen = useRef<number | null>(null)
  const bufferedEvents = useRef<GatewayEvent[]>([])
  const historyPageOffset = useRef(0)
  const historyUserTurnOffset = useRef(0)
  const historyHasEarlierRef = useRef(false)
  const historyPageLoading = useRef(false)
  const presentationCardsRef = useRef(new Map<string, readonly SessionPresentationCard[]>())
  const presentationLoadGeneration = useRef(new Map<string, number>())
  const terminalPresentationReconciler = useRef(new PresentationTerminalReconciler())
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [historyReady, setHistoryReady] = useState(true)
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false)
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false)
  const [runtime, setRuntime] = useState<SessionRuntime>(() =>
    emptyRuntime(currentProfile?.model ?? '', currentProfile?.provider ?? ''),
  )

  const sessionsQuery = useQuery({
    queryKey: ['sessions', profile],
    queryFn: () => chatApi.sessions(profile, 100),
  })
  const modelInfoQuery = useQuery({
    queryKey: modelKeys.info(profile),
    queryFn: () => modelSelectionApi.info(profile),
  })

  const selectSessions = (live: string | null, history: string | null) => {
    const next = { live, history }
    selectedRef.current = next
    if (typeof window !== 'undefined') writeSelectedSession(window.localStorage, profile, history)
    setSelectedState(next)
  }

  const setEarlierHistoryAvailable = (available: boolean) => {
    historyHasEarlierRef.current = available
    setHasEarlierMessages(available)
  }

  const effectiveRuntime = useMemo<SessionRuntime>(() => {
    if (selected.live) return runtime
    return {
      ...runtime,
      model: currentProfile?.model ?? modelInfoQuery.data?.model ?? runtime.model,
      provider: currentProfile?.provider ?? modelInfoQuery.data?.provider ?? runtime.provider,
      contextWindow: modelInfoQuery.data?.effective_context_length ?? runtime.contextWindow,
    }
  }, [currentProfile, modelInfoQuery.data, runtime, selected.live])
  const reasoningSupported =
    modelInfoQuery.data?.model === effectiveRuntime.model &&
    modelInfoQuery.data.provider === effectiveRuntime.provider &&
    modelInfoQuery.data.capabilities.supports_reasoning === true

  const handleGatewayEvent = (event: GatewayEvent) => {
    if (event.type === 'gateway.ready') {
      const nextEpoch = event.replay_epoch ?? null
      if (replayEpochChanged(recoveryEpoch.current, nextEpoch)) {
        eventWatermarks.current.clear()
        epochResetPending.current = true
      }
      if (nextEpoch) recoveryEpoch.current = nextEpoch
      return
    }
    if (!eventBelongsToSelection(event, profile, selectedRef.current)) return
    if (hydratingOpen.current != null) {
      bufferedEvents.current.push(event)
      return
    }
    if (!acceptGatewayEvent(eventWatermarks.current, event)) return

    if (event.type === 'session.info' || event.type === 'session.usage') {
      setRuntime((previous) => mergeRuntime(previous, event))
      return
    }
    setMessages((current) => applyGatewayEvent(current, event))
    const storedSessionId = selectedRef.current.history
    if (storedSessionId && (event.type === 'message.start' || event.type === 'tool.start')) {
      terminalPresentationReconciler.current.markTurnActivity(storedSessionId)
    }
    if (storedSessionId && refreshesPresentationLedger(event)) {
      // Reconcile once the turn is terminal: the live reducer is still the
      // fast path, while the durable ledger repairs any missed WS lifecycle.
      runPresentationTerminalReconciliation(
        terminalPresentationReconciler.current,
        storedSessionId,
        () => loadPresentation(storedSessionId),
      )
    }
    if (event.type === 'message.start' || event.type === 'tool.start') {
      setBusy(true)
      setRuntime((previous) => ({
        ...previous,
        turnStartedAt: previous.turnStartedAt ?? Date.now() / 1000,
      }))
    }
    if (event.type === 'message.complete' || event.type === 'turn.end' || event.type === 'error') {
      setBusy(false)
      setRuntime((previous) => ({
        ...previous,
        turnStartedAt: null,
        lastTurnSeconds: previous.turnStartedAt
          ? Date.now() / 1000 - previous.turnStartedAt
          : previous.lastTurnSeconds,
      }))
      void queryClient.invalidateQueries({ queryKey: ['sessions', profile] }).catch(() => undefined)
    }
  }

  const handleConnectionState = (state: ConnectionState) => {
    if (state !== 'closed' && state !== 'error') return
    // A socket close says nothing about the active turn. Keep it locked until
    // session.resume/replay tells us whether the gateway finished it; otherwise
    // users can accidentally submit a second turn during a reconnect.
  }

  const {
    request,
    state: connectionState,
    connectionGeneration,
  } = useGatewayConnection({
    epoch,
    onEvent: handleGatewayEvent,
    onState: handleConnectionState,
  })

  async function loadPresentation(storedSessionId: string) {
    const generation = (presentationLoadGeneration.current.get(storedSessionId) ?? 0) + 1
    presentationLoadGeneration.current.set(storedSessionId, generation)
    try {
      const presentation = parseSessionPresentationListResult(
        await request('session.presentation.list', {
          session_id: storedSessionId,
          profile,
          limit: 256,
        }),
      )
      if (
        selectedRef.current.history !== storedSessionId ||
        presentationLoadGeneration.current.get(storedSessionId) !== generation
      ) {
        return
      }
      presentationCardsRef.current.set(storedSessionId, presentation.cards)
      setMessages(
        (current) =>
          mergePresentationIntoMessages(current, presentation.cards, historyUserTurnOffset.current)
            .messages,
      )
    } catch {
      // Gateways prior to the presentation ledger simply have no extra cards.
    }
  }

  const mergeCachedPresentation = (items: ChatMessage[], storedSessionId: string) =>
    mergePresentationIntoMessages(
      items,
      presentationCardsRef.current.get(storedSessionId) ?? [],
      historyUserTurnOffset.current,
    ).messages
  const selectRecoveredSession = useEffectEvent(selectSessions)
  const applyRecoveredGatewayEvent = useEffectEvent(handleGatewayEvent)
  const loadRecoveredPresentation = useEffectEvent(loadPresentation)

  useEffect(() => {
    if (!connectionGeneration || connectionState !== 'open') return
    const alreadyConnected = reconnectSeen.current
    reconnectSeen.current = true
    if (!alreadyConnected) return
    const storedSessionId = selectedRef.current.history
    if (!storedSessionId) return
    let disposed = false
    const recover = async () => {
      try {
        const resumed = parseSessionResumeResult(
          await request('session.resume', {
            session_id: storedSessionId,
            profile,
            omit_messages: true,
          }),
        )
        if (disposed || selectedRef.current.history !== storedSessionId || !resumed.session_id)
          return
        const durableId = resumed.stored_session_id ?? storedSessionId
        selectRecoveredSession(resumed.session_id, durableId)
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

        const lastSeen = eventWatermarks.current.get(resumed.session_id) ?? 0
        const replay = parseSessionEventsSinceResult(
          await request('session.events.since', {
            session_id: resumed.session_id,
            last_seen: lastSeen,
          }),
        )
        if (disposed || selectedRef.current.history !== durableId) return
        const epochChanged =
          epochResetPending.current || replayEpochChanged(recoveryEpoch.current, replay.epoch)
        if (replay.epoch) recoveryEpoch.current = replay.epoch
        epochResetPending.current = false
        if (epochChanged) eventWatermarks.current.clear()
        if (epochChanged || replay.truncated) {
          const history = await chatApi.messages(durableId, profile)
          if (disposed || selectedRef.current.history !== durableId) return
          historyUserTurnOffset.current = history.pagination.user_turn_offset
          setMessages(reconstructMessages(history.messages))
        }
        for (const event of replay.events) applyRecoveredGatewayEvent(event)
        const watermark = eventWatermarks.current.get(resumed.session_id) ?? 0
        eventWatermarks.current.set(resumed.session_id, Math.max(watermark, replay.latest_seq))
        void loadRecoveredPresentation(durableId)
      } catch {
        // Keep the reconnect loop alive. A later socket will resume again.
      }
    }
    void recover()
    return () => {
      disposed = true
    }
  }, [connectionGeneration, connectionState, profile, request])

  useEffect(() => {
    const sessionId = selected.live
    if (!sessionId || connectionState !== 'open') return
    let disposed = false
    const pullUsage = async () => {
      try {
        const usage = parseSessionUsageResult(
          await request('session.usage', { session_id: sessionId }),
        )
        if (!disposed) {
          setRuntime((previous) => ({ ...previous, usage: mergeUsage(previous.usage, usage) }))
        }
        try {
          const context = parseContextBreakdownResult(
            await request('session.context_breakdown', { session_id: sessionId }),
          )
          if (!disposed && (context.context_used || context.context_max)) {
            setRuntime((previous) => ({
              ...previous,
              contextWindow: context.context_max || previous.contextWindow,
              usage: mergeUsage(previous.usage, context),
            }))
          }
        } catch {
          // Older gateways do not expose the optional context breakdown method.
        }
      } catch {
        // A restored session may not be live yet; the next interval retries.
      }
    }
    void pullUsage()
    const timer = window.setInterval(pullUsage, busy ? 2_500 : 12_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [busy, connectionState, request, selected.live])

  const { openSession, loadEarlierMessages } = useSessionHistory({
    profile,
    connectionState,
    request,
    sessions: sessionsQuery.data?.sessions ?? EMPTY_SESSIONS,
    contextWindow: modelInfoQuery.data?.effective_context_length ?? 0,
    refs: {
      selected: selectedRef,
      openGeneration,
      operationGeneration,
      hydratingOpen,
      bufferedEvents,
      historyPageOffset,
      historyUserTurnOffset,
      historyHasEarlier: historyHasEarlierRef,
      historyPageLoading,
      eventWatermarks,
      recoveryEpoch,
      epochResetPending,
      restoreAttempted,
    },
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
    makeSystemMessage: systemMessage,
  })

  const { send, stop, newChat, setDialogModel, setDialogReasoning } = useChatActions({
    profile,
    connectionState,
    request,
    queryClient,
    refs: {
      selected: selectedRef,
      openGeneration,
      operationGeneration,
      stopGeneration,
      reasoningConfigGeneration,
      sendInFlight,
      sendNonce,
      hydratingOpen,
      bufferedEvents,
      historyPageOffset,
    },
    draft,
    busy,
    historyReady,
    effectiveRuntime,
    reasoningSupported,
    profileDefaults: currentProfile,
    modelInfo: modelInfoQuery.data,
    selectSessions,
    setEarlierHistoryAvailable,
    setDraft,
    setMessages,
    setBusy,
    setRuntime,
    setHistoryReady,
    makeSystemMessage: systemMessage,
    markPresentationTurnSubmitted: () => {
      const storedSessionId = selectedRef.current.history
      if (storedSessionId) terminalPresentationReconciler.current.markTurnSubmitted(storedSessionId)
    },
  })

  const value: ChatRuntimeContextValue = {
    sessionId: selected.live,
    historySessionId: selected.history,
    messages,
    draft,
    setDraft,
    busy,
    connectionState,
    historyReady,
    loadError: combinedErrorMessage(
      [sessionsQuery.error, 'не удалось загрузить сессии'],
      [modelInfoQuery.error, 'не удалось загрузить параметры модели'],
    ),
    runtime: effectiveRuntime,
    reasoningSupported,
    sessions: sessionsQuery.data?.sessions ?? EMPTY_SESSIONS,
    sessionsLoading: sessionsQuery.isPending,
    openSession,
    loadEarlierMessages,
    hasEarlierMessages,
    loadingEarlierMessages,
    send,
    stop,
    newChat,
    setDialogModel,
    setDialogReasoning,
  }

  return <ChatRuntimeContext.Provider value={value}>{children}</ChatRuntimeContext.Provider>
}
