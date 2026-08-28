import { describe, expect, it } from 'vitest'
import { combinedErrorMessage, errorMessage } from './error-message'

describe('error messages', () => {
  it('uses useful Error/string messages and a safe fallback', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed')
    expect(errorMessage('denied')).toBe('denied')
    expect(errorMessage(null, 'fallback')).toBe('fallback')
  })

  it('keeps every independent error without duplicating identical messages', () => {
    expect(
      combinedErrorMessage(
        [new Error('profiles failed'), 'profiles fallback'],
        [new Error('gateway failed'), 'gateway fallback'],
        [null, 'unused'],
        ['profiles failed'],
      ),
    ).toBe('profiles failed · gateway failed')
    expect(combinedErrorMessage([null], [undefined])).toBeNull()
  })
})
