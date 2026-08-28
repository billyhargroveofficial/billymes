import { describe, expect, it } from 'vitest'
import { eventBelongsToSelection } from './event-scope'

describe('eventBelongsToSelection', () => {
  const selected = { live: 'live-1', history: 'history-1' }

  it('accepts only the active profile and selected session generations', () => {
    expect(
      eventBelongsToSelection(
        { type: 'message.delta', profile: 'research', session_id: 'live-1' },
        'research',
        selected,
      ),
    ).toBe(true)
    expect(
      eventBelongsToSelection(
        { type: 'message.delta', profile: 'other', session_id: 'live-1' },
        'research',
        selected,
      ),
    ).toBe(false)
    expect(
      eventBelongsToSelection(
        { type: 'message.delta', profile: 'research', session_id: 'old-session' },
        'research',
        selected,
      ),
    ).toBe(false)
  })

  it('drops unscoped late session events after new chat detaches the selection', () => {
    expect(
      eventBelongsToSelection({ type: 'message.complete', session_id: 'old-session' }, 'default', {
        live: null,
        history: null,
      }),
    ).toBe(false)
    expect(
      eventBelongsToSelection({ type: 'message.complete' }, 'default', {
        live: null,
        history: null,
      }),
    ).toBe(false)
    expect(
      eventBelongsToSelection({ type: 'gateway.status' }, 'default', { live: null, history: null }),
    ).toBe(true)
  })

  it('requires a session binding even while another session is selected', () => {
    expect(eventBelongsToSelection({ type: 'message.delta' }, 'default', selected)).toBe(false)
    expect(eventBelongsToSelection({ type: 'session.info' }, 'default', selected)).toBe(false)
    expect(eventBelongsToSelection({ type: 'heartbeat' }, 'default', selected)).toBe(false)
  })

  it('accepts only explicitly allowlisted global events without a session', () => {
    expect(eventBelongsToSelection({ type: 'gateway.status' }, 'default', selected)).toBe(true)
    expect(
      eventBelongsToSelection({ type: 'gateway.status' }, 'default', {
        live: 'live-1',
        history: 'history-1',
      }),
    ).toBe(true)
  })
})
