import { describe, expect, it } from 'vitest'
import {
  canSendChat,
  isCurrentConfigOperation,
  isCurrentSessionOperation,
  submitMayHaveBeenAccepted,
} from './chat-race'

describe('chat race guards', () => {
  it('blocks send while history hydration is pending', () => {
    expect(canSendChat('hello', false, false)).toBe(false)
    expect(canSendChat('hello', false, true)).toBe(true)
    expect(canSendChat('   ', false, true)).toBe(false)
    expect(canSendChat('hello', true, true)).toBe(false)
  })

  it('rejects a stop result after the session generation changes', () => {
    const token = { operationGeneration: 3, sessionId: 'session-a' }
    expect(
      isCurrentSessionOperation(token, {
        operationGeneration: 3,
        sessionId: 'session-a',
      }),
    ).toBe(true)
    expect(
      isCurrentSessionOperation(token, {
        operationGeneration: 4,
        sessionId: 'session-b',
      }),
    ).toBe(false)
  })

  it('rejects an older config callback after a newer selection', () => {
    const oldToken = {
      operationGeneration: 5,
      sessionId: 'session-a',
      configGeneration: 1,
    }
    expect(
      isCurrentConfigOperation(oldToken, {
        operationGeneration: 5,
        sessionId: 'session-a',
        configGeneration: 2,
      }),
    ).toBe(false)
    expect(
      isCurrentConfigOperation(
        { ...oldToken, configGeneration: 2 },
        {
          operationGeneration: 5,
          sessionId: 'session-a',
          configGeneration: 2,
        },
      ),
    ).toBe(true)
  })

  it('clears attachments only for an uncertain prompt submission', () => {
    expect(submitMayHaveBeenAccepted({ delivery: 'uncertain', method: 'prompt.submit' })).toBe(true)
    expect(submitMayHaveBeenAccepted({ delivery: 'uncertain', method: 'session.create' })).toBe(
      false,
    )
    expect(submitMayHaveBeenAccepted({ delivery: 'unsent', method: 'prompt.submit' })).toBe(false)
  })
})
