import { createContext } from 'react'

export type Theme = 'dark' | 'light'
/** What the user picked: an explicit theme, or follow the OS. */
export type ThemeMode = Theme | 'system'

export type ThemeContextValue = {
  theme: Theme
  mode: ThemeMode
  toggle: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

const STORAGE_KEY = 'mes.theme-mode'

export function readThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  return 'system'
}

export function persistThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // The in-memory mode still works when storage is unavailable.
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? systemTheme() : mode
}

/** The toggle walks system → light → dark and back to system. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'system') return 'light'
  if (mode === 'light') return 'dark'
  return 'system'
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  // Safari paints its toolbar with this и blends into the page — the value
  // must match the header's --panel tone, not the page ground, or a seam
  // shows right under the browser chrome.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#FBFAF6' : '#161921')
}
