import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import { chatApi } from '../api/chat-api'
import type { SessionResumeResult } from './rpc-contracts'
import { applyOpenSessionResume, startSessionOpenRequests } from './session-open-recovery'
import type { SessionRuntime } from './types'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('session open request ordering', () => {
  it('reattaches the live gateway before an unresolved REST history page', () => {
    const order: string[] = []
    const unresolvedHistory = new Promise<never>(() => undefined)
    vi.spyOn(chatApi, 'messages').mockImplementation(() => {
      order.push('history')
      return unresolvedHistory
    })
    vi.spyOn(chatApi, 'detail').mockImplementation(async () => {
      order.push('detail')
      return {} as never
    })
    const request = vi.fn(() => {
      order.push('resume')
      return Promise.resolve({})
    })

    const requests = startSessionOpenRequests('default', 'stored-session', request)

    expect(order).toEqual(['resume', 'history', 'detail'])
    expect(request).toHaveBeenCalledWith('session.resume', {
      session_id: 'stored-session',
      profile: 'default',
      omit_messages: true,
    })
    expect(requests.history).toBe(unresolvedHistory)
  })

  it('applies resumed live identity and busy state before history settles', async () => {
    const unresolvedHistory = new Promise<never>(() => undefined)
    vi.spyOn(chatApi, 'messages').mockReturnValue(unresolvedHistory)
    vi.spyOn(chatApi, 'detail').mockResolvedValue({} as never)
    const resumed: SessionResumeResult = {
      session_id: 'live-session',
      stored_session_id: 'durable-session',
      info: { model: 'gpt-test' },
      running: true,
      turn_started_at: 42,
      inflight: {
        user: 'still working',
        history_anchor_display_key: `display:v1:${'b'.repeat(64)}`,
      },
    }
    const requests = startSessionOpenRequests(
      'default',
      'durable-session',
      vi.fn(() => Promise.resolve(resumed)),
    )
    let runtime: SessionRuntime = {
      model: '',
      provider: '',
      reasoning: '',
      usage: {},
      turnStartedAt: null,
      sessionStartedAt: null,
      lastTurnSeconds: null,
      contextWindow: 128,
    }
    let busy = false
    const selected: Array<[string | null, string | null]> = []
    const setRuntime: Dispatch<SetStateAction<SessionRuntime>> = (update) => {
      runtime = typeof update === 'function' ? update(runtime) : update
    }
    const setBusy: Dispatch<SetStateAction<boolean>> = (update) => {
      busy = typeof update === 'function' ? update(busy) : update
    }

    applyOpenSessionResume((await requests.resume) as SessionResumeResult, {
      id: 'durable-session',
      isCurrent: () => true,
      selectSessions: (live, history) => selected.push([live, history]),
      setBusy,
      setRuntime,
    })

    expect(requests.history).toBe(unresolvedHistory)
    expect(selected).toEqual([['live-session', 'durable-session']])
    expect(busy).toBe(true)
    expect(runtime).toMatchObject({ model: 'gpt-test', turnStartedAt: 42 })
  })

  it('refreshes the sidebar when resume advances to a compression tip', () => {
    const refresh = vi.fn()
    const select = vi.fn()
    applyOpenSessionResume(
      {
        session_id: 'live-session',
        stored_session_id: 'durable-tip',
        info: null,
        running: false,
        turn_started_at: null,
        inflight: null,
      },
      {
        id: 'durable-root',
        isCurrent: () => true,
        selectSessions: select,
        onDurableIdentityChanged: refresh,
        setBusy: vi.fn(),
        setRuntime: vi.fn(),
      },
    )

    expect(select).toHaveBeenCalledWith('live-session', 'durable-tip')
    expect(refresh).toHaveBeenCalledOnce()
  })
})
