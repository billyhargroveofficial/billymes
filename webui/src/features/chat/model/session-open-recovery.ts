import type { Dispatch, SetStateAction } from 'react'
import { chatApi, HISTORY_PAGE_SIZE } from '../api/chat-api'
import { mergeRuntime } from './chat-runtime'
import type { SessionResumeResult } from './rpc-contracts'
import type { SessionRuntime } from './types'

type Request = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>

/** Start the live reattachment before an arbitrarily slow REST history read. */
export function startSessionOpenRequests(profile: string, id: string, request: Request) {
  return {
    // Reattaching promptly cancels the gateway's detached-browser reap timer.
    resume: request('session.resume', { session_id: id, profile, omit_messages: true }),
    history: chatApi.messages(id, profile, { limit: HISTORY_PAGE_SIZE, offset: 0 }),
    detail: chatApi.detail(id, profile),
  }
}

/** Apply an idempotent resume snapshot as soon as it arrives, before REST. */
export function applyOpenSessionResume(
  resumed: SessionResumeResult,
  {
    id,
    isCurrent,
    selectSessions,
    onDurableIdentityChanged,
    setBusy,
    setRuntime,
  }: {
    id: string
    isCurrent: () => boolean
    selectSessions: (live: string | null, history: string | null) => void
    onDurableIdentityChanged?: () => void
    setBusy: Dispatch<SetStateAction<boolean>>
    setRuntime: Dispatch<SetStateAction<SessionRuntime>>
  },
) {
  if (!isCurrent()) return
  const durableId = resumed.stored_session_id ?? id
  if (resumed.session_id) {
    selectSessions(resumed.session_id, durableId)
    if (durableId !== id) onDurableIdentityChanged?.()
  }
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
}
