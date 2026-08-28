import { describe, expect, it } from 'vitest'
import { paneState } from './pane-state'

describe('paneState', () => {
  it('prefers the skeleton while a query is pending', () => {
    expect(paneState({ pending: true, error: 'boom', empty: true })).toBe('skeleton')
  })

  it('shows the error before the empty state', () => {
    expect(paneState({ pending: false, error: 'boom', empty: true })).toBe('error')
  })

  it('falls through to empty and ready', () => {
    expect(paneState({ pending: false, error: null, empty: true })).toBe('empty')
    expect(paneState({ pending: false, error: null, empty: false })).toBe('ready')
  })
})
