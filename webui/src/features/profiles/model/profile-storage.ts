const PROFILE_KEY = 'mes.profile'

export function readStoredProfile() {
  try {
    return localStorage.getItem(PROFILE_KEY) || 'default'
  } catch {
    return 'default'
  }
}

export function persistProfile(name: string) {
  try {
    localStorage.setItem(PROFILE_KEY, name)
  } catch {
    // The in-memory selection remains usable without storage.
  }
}
