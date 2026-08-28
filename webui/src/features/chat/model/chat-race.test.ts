import { describe, expect, it } from 'vitest'
import {
  canSendChat,
  isCurrentConfigOperation,
  isCurrentSessionOperation,
  submitMayHaveBeenAccepted,
  submitThenRefreshSessionCatalog,
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

  it('refreshes the durable session catalog only after submit settles', async () => {
    let settleSubmit: ((value: string) => void) | undefined
    const order: string[] = []
    const submitted = new Promise<string>((resolve) => {
      settleSubmit = resolve
    })
    const pending = submitThenRefreshSessionCatalog(
      () => {
        order.push('submit')
        return submitted
      },
      async () => {
        order.push('refresh')
      },
    )

    expect(order).toEqual(['submit'])
    settleSubmit?.('accepted')
    await expect(pending).resolves.toBe('accepted')
    expect(order).toEqual(['submit', 'refresh'])
  })

  it('refreshes after a rejected submit without masking its delivery error', async () => {
    const deliveryError = new Error('uncertain submit')
    let refreshed = false
    await expect(
      submitThenRefreshSessionCatalog(
        async () => {
          throw deliveryError
        },
        async () => {
          refreshed = true
          throw new Error('catalog unavailable')
        },
      ),
    ).rejects.toBe(deliveryError)
    expect(refreshed).toBe(true)
  })
})
