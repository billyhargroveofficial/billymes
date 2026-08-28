import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  applyTheme,
  nextThemeMode,
  persistThemeMode,
  readThemeMode,
  resolveTheme,
  ThemeContext,
  type Theme,
  type ThemeContextValue,
  type ThemeMode,
} from './theme-context'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeToSystemTheme(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function readSystemDark() {
  return window.matchMedia(DARK_QUERY).matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    if (typeof document === 'undefined') return 'system'
    const initial = readThemeMode()
    applyTheme(resolveTheme(initial))
    return initial
  })
  // Live OS preference; only consulted while the mode is 'system'.
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, readSystemDark, () => true)
  const theme: Theme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    persistThemeMode(mode)
  }, [mode])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode,
      toggle: () => setMode((current) => nextThemeMode(current)),
    }),
    [theme, mode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
