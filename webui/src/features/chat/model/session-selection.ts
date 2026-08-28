const PREFIX = 'hermes.chat.selected-session.v1:'
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export function selectedSessionStorageKey(profile: string) {
  return `${PREFIX}${profile}`
}

export function readSelectedSession(storage: Storage, profile: string) {
  try {
    const value = storage.getItem(selectedSessionStorageKey(profile))
    return value && SAFE_SESSION_ID.test(value) ? value : null
  } catch {
    return null
  }
}

export function writeSelectedSession(storage: Storage, profile: string, sessionId: string | null) {
  const key = selectedSessionStorageKey(profile)
  try {
    if (!sessionId) {
      storage.removeItem(key)
      return
    }
    if (SAFE_SESSION_ID.test(sessionId)) storage.setItem(key, sessionId)
  } catch {
    // Private browsing / disabled storage must not break chat recovery.
  }
}

export function shouldRestoreSelectedSession(
  connectionState: 'idle' | 'connecting' | 'open' | 'closed' | 'error',
  sessionId: string | null,
  alreadyAttempted: boolean,
) {
  return connectionState === 'open' && Boolean(sessionId) && !alreadyAttempted
}
