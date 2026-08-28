import { describe, expect, it } from 'vitest'
import {
  readSelectedSession,
  selectedSessionStorageKey,
  shouldRestoreSelectedSession,
  writeSelectedSession,
} from './session-selection'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage
}

describe('persisted selected durable session', () => {
  it('is profile-scoped, safe, and removed when the selection closes', () => {
    const target = storage()
    writeSelectedSession(target, 'default', 'stored:one')
    expect(readSelectedSession(target, 'default')).toBe('stored:one')
    expect(readSelectedSession(target, 'work')).toBeNull()
    writeSelectedSession(target, 'default', null)
    expect(target.getItem(selectedSessionStorageKey('default'))).toBeNull()
  })

  it('restores the saved durable id once the gateway is open', () => {
    expect(shouldRestoreSelectedSession('connecting', 'stored:one', false)).toBe(false)
    expect(shouldRestoreSelectedSession('open', 'stored:one', false)).toBe(true)
    expect(shouldRestoreSelectedSession('open', 'stored:one', true)).toBe(false)
  })
})
