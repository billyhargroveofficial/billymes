import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { ConnectionState, GatewayEvent } from '@/features/gateway'
import { modelKeys, modelSelectionApi } from '@/features/model-selection'
import { errorMessage } from '@/shared/lib/error-message'
import { DEFAULT_CONTEXT_WINDOW, emptyRuntime } from './chat-runtime'
import {
  canSendChat,
  isCurrentConfigOperation,
  isCurrentSessionOperation,
  submitMayHaveBeenAccepted,
} from './chat-race'
import { userMessage } from './chat-messages'
import type { SelectedSessions } from './event-scope'
import { parseSessionCreateResult } from './rpc-contracts'
import type { ChatMessage, SessionRuntime } from './types'

type Request = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>

type ActionRefs = {
  selected: MutableRefObject<SelectedSessions>
  openGeneration: MutableRefObject<number>
  operationGeneration: MutableRefObject<number>
  stopGeneration: MutableRefObject<number>
  reasoningConfigGeneration: MutableRefObject<number>
  sendInFlight: MutableRefObject<number | null>
  sendNonce: MutableRefObject<number>
  hydratingOpen: MutableRefObject<number | null>
  bufferedEvents: MutableRefObject<GatewayEvent[]>
  historyPageOffset: MutableRefObject<number>
  historyThroughDisplayKey: MutableRefObject<string | null>
}

type ProfileDefaults = {
  model?: string | null
  provider?: string | null
}

type ModelInfo = {
  model?: string
  provider?: string
  effective_context_length?: number
}

type UseChatActionsOptions = {
  profile: string
  connectionState: ConnectionState
  request: Request
  queryClient: QueryClient
  refs: ActionRefs
  draft: string
  busy: boolean
  historyReady: boolean
  effectiveRuntime: SessionRuntime
  reasoningSupported: boolean
  profileDefaults?: ProfileDefaults | undefined
  modelInfo?: ModelInfo | undefined
  selectSessions: (live: string | null, history: string | null) => void
  setEarlierHistoryAvailable: (available: boolean) => void
  setDraft: Dispatch<SetStateAction<string>>
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setRuntime: Dispatch<SetStateAction<SessionRuntime>>
  setHistoryReady: Dispatch<SetStateAction<boolean>>
  makeSystemMessage: (message: string) => ChatMessage
  markPresentationTurnSubmitted: () => void
}

/** Command-side state transitions for the persistent chat controller. */
export function useChatActions({
  profile,
  connectionState,
  request,
  queryClient,
  refs,
  draft,
  busy,
  historyReady,
  effectiveRuntime,
  reasoningSupported,
  profileDefaults,
  modelInfo,
  selectSessions,
  setEarlierHistoryAvailable,
  setDraft,
  setMessages,
  setBusy,
  setRuntime,
  setHistoryReady,
  makeSystemMessage,
  markPresentationTurnSubmitted,
}: UseChatActionsOptions) {
  async function ensureSession(generation: number) {
    if (refs.selected.current.live) return refs.selected.current.live
    const created = await request('session.create', {
      profile: profile === 'default' ? undefined : profile,
      source: 'web',
      model: effectiveRuntime.model || undefined,
      provider: effectiveRuntime.provider || undefined,
      reasoning_effort: reasoningSupported ? effectiveRuntime.reasoning || undefined : undefined,
    })
    const parsed = parseSessionCreateResult(created)
    if (generation !== refs.operationGeneration.current) return null
    selectSessions(parsed.session_id, parsed.stored_session_id)
    setRuntime((previous) => ({ ...previous, sessionStartedAt: Date.now() / 1000 }))
    void queryClient.invalidateQueries({ queryKey: ['sessions', profile] }).catch(() => undefined)
    return parsed.session_id
  }

  async function send(attachmentMarkers: string[] = []) {
    const markerBlock = attachmentMarkers.join('\n')
    const text = [draft.trim(), markerBlock].filter(Boolean).join('\n\n')
    if (refs.sendInFlight.current != null || !canSendChat(text, busy, historyReady)) return false
    const generation = refs.operationGeneration.current
    const token = ++refs.sendNonce.current
    refs.sendInFlight.current = token
    setDraft('')
    setMessages((current) => [...current, userMessage(text)])
    setBusy(true)
    setRuntime((previous) => ({ ...previous, turnStartedAt: Date.now() / 1000 }))
    try {
      const sessionId = await ensureSession(generation)
      if (!sessionId) return false
      // The durable hosted-card recovery needs a stable client turn boundary.
      // Do this before prompt.submit: an uncertain submit is still one turn
      // and the following submit intentionally begins a new generation.
      markPresentationTurnSubmitted()
      await request('prompt.submit', { session_id: sessionId, text })
      return true
    } catch (error) {
      if (generation !== refs.operationGeneration.current) return false
      if (submitMayHaveBeenAccepted(error)) {
        // The gateway may already have accepted prompt.submit. Keep the turn
        // locked until resume/replay proves its state; never resend or restore
        // the draft, which would invite a duplicate request.
        setBusy(true)
        return true
      }
      setBusy(false)
      setDraft((current) => current || text)
      setRuntime((previous) => ({ ...previous, turnStartedAt: null }))
      setMessages((current) => [
        ...current,
        makeSystemMessage(error instanceof Error ? error.message : 'send failed'),
      ])
      return false
    } finally {
      if (refs.sendInFlight.current === token) refs.sendInFlight.current = null
    }
  }

  async function stop() {
    const generation = refs.operationGeneration.current
    const sessionId = refs.selected.current.live
    if (!sessionId) return
    const requestGeneration = ++refs.stopGeneration.current
    const token = { operationGeneration: generation, sessionId }
    const isCurrent = () =>
      requestGeneration === refs.stopGeneration.current &&
      isCurrentSessionOperation(token, {
        operationGeneration: refs.operationGeneration.current,
        sessionId: refs.selected.current.live,
      })
    try {
      await request('session.interrupt', { session_id: sessionId })
    } catch (error) {
      if (!isCurrent()) return
      setMessages((current) => [
        ...current,
        makeSystemMessage(errorMessage(error, 'не удалось остановить ответ')),
      ])
      // A failed interrupt says neither that the turn stopped nor that it is
      // safe to submit another prompt. In particular, a lost reply can mean
      // the interrupt was accepted while the original turn is still replaying.
      // Keep the UI locked until the reconnect's session.resume is decisive.
      return
    }
    if (!isCurrent()) return
    setBusy(false)
    setRuntime((previous) => ({
      ...previous,
      turnStartedAt: null,
      lastTurnSeconds: previous.turnStartedAt
        ? Date.now() / 1000 - previous.turnStartedAt
        : previous.lastTurnSeconds,
    }))
  }

  function newChat() {
    const previousSession = refs.selected.current.live
    const wasBusy = busy
    refs.openGeneration.current += 1
    refs.operationGeneration.current += 1
    refs.sendInFlight.current = null
    refs.hydratingOpen.current = null
    refs.bufferedEvents.current = []
    refs.historyPageOffset.current = 0
    refs.historyThroughDisplayKey.current = null
    setEarlierHistoryAvailable(false)
    selectSessions(null, null)
    setMessages([])
    setHistoryReady(true)
    setBusy(false)
    setRuntime(
      emptyRuntime(
        profileDefaults?.model ?? modelInfo?.model ?? '',
        profileDefaults?.provider ?? modelInfo?.provider ?? '',
        modelInfo?.effective_context_length ?? DEFAULT_CONTEXT_WINDOW,
      ),
    )
    if (wasBusy && previousSession) {
      void request('session.interrupt', { session_id: previousSession }).catch(() => undefined)
    }
  }

  async function setDialogModel(nextProvider: string, nextModel: string) {
    const previousModel = effectiveRuntime.model
    const previousProvider = effectiveRuntime.provider
    setRuntime((previous) => ({ ...previous, model: nextModel, provider: nextProvider }))
    try {
      await modelSelectionApi.setProfileMainModel(profile, nextProvider, nextModel)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
      ])
    } catch (error) {
      setRuntime((previous) => ({
        ...previous,
        model: previousModel,
        provider: previousProvider,
      }))
      setMessages((current) => [
        ...current,
        makeSystemMessage(errorMessage(error, 'не удалось сменить модель')),
      ])
    }
  }

  async function setDialogReasoning(level: string) {
    if (!reasoningSupported) return
    const generation = refs.operationGeneration.current
    const configGeneration = ++refs.reasoningConfigGeneration.current
    const sessionId = refs.selected.current.live
    const previousReasoning = effectiveRuntime.reasoning
    setRuntime((previous) => ({ ...previous, reasoning: level }))
    if (!sessionId || connectionState !== 'open') return
    try {
      await request('config.set', {
        key: 'reasoning',
        value: level,
        session_id: sessionId,
      })
    } catch (error) {
      if (
        !isCurrentConfigOperation(
          { operationGeneration: generation, sessionId, configGeneration },
          {
            operationGeneration: refs.operationGeneration.current,
            sessionId: refs.selected.current.live,
            configGeneration: refs.reasoningConfigGeneration.current,
          },
        )
      ) {
        return
      }
      setRuntime((previous) => ({ ...previous, reasoning: previousReasoning }))
      setMessages((current) => [
        ...current,
        makeSystemMessage(errorMessage(error, 'не удалось сменить reasoning')),
      ])
    }
  }

  return { send, stop, newChat, setDialogModel, setDialogReasoning }
}
