import { describe, expect, it } from 'vitest'
import { createAsyncScopeGuard } from './async-scope'

describe('createAsyncScopeGuard', () => {
  it('rejects a completion after changing profile or session', () => {
    const guard = createAsyncScopeGuard({ profile: 'default', scopeKey: 'session-a' })
    const pending = guard.capture()

    guard.setScope({ profile: 'worker', scopeKey: 'session-b' })

    expect(guard.isCurrent(pending)).toBe(false)
  })

  it('does not revive a request when switching away and back to the same scope', () => {
    const guard = createAsyncScopeGuard({ profile: 'default', scopeKey: 'session-a' })
    const firstRequest = guard.capture()

    guard.setScope({ profile: 'worker', scopeKey: 'session-b' })
    guard.setScope({ profile: 'default', scopeKey: 'session-a' })

    expect(guard.isCurrent(firstRequest)).toBe(false)
    expect(guard.isCurrent(guard.capture())).toBe(true)
  })

  it('rejects work when its UI scope unmounts', () => {
    const guard = createAsyncScopeGuard({ profile: 'default', scopeKey: 'session-a' })
    const pending = guard.capture()

    guard.invalidate()

    expect(guard.isCurrent(pending)).toBe(false)
  })
})
