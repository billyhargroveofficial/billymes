import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import {
  fetchGatewayRuntime,
  pushGatewaySettings,
  readGatewaySettings,
  writeGatewaySettings,
  type GatewayRuntimeInfo,
  type GatewaySettings,
} from './gateway-settings'
import { GatewayContext, type GatewayContextValue } from './gateway-context'

export function GatewayProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [settings, setSettings] = useState<GatewaySettings>(() =>
    typeof window === 'undefined'
      ? { mode: 'local', origin: '', host: '', token: '' }
      : readGatewaySettings(),
  )
  const [runtime, setRuntime] = useState<GatewayRuntimeInfo | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applyControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const boot = async () => {
      try {
        const info = await pushGatewaySettings(readGatewaySettings(), controller.signal)
        if (!cancelled) {
          const nextRuntime = info ?? (await fetchGatewayRuntime(controller.signal))
          if (cancelled) return
          setRuntime(nextRuntime)
          setError(null)
        }
      } catch (bootError) {
        if (cancelled || controller.signal.aborted) return
        const fallback = await fetchGatewayRuntime(controller.signal).catch(() => null)
        if (cancelled || controller.signal.aborted) return
        setRuntime(fallback)
        setError(errorMessage(bootError, 'локальный proxy не отвечает'))
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    void boot()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  useEffect(() => {
    return () => {
      applyControllerRef.current?.abort()
    }
  }, [])

  const apply = useCallback(
    async (next: GatewaySettings) => {
      const controller = new AbortController()
      applyControllerRef.current = controller
      try {
        const info = await pushGatewaySettings(next, controller.signal)
        if (controller.signal.aborted) return
        const nextRuntime = info ?? (await fetchGatewayRuntime(controller.signal))
        if (controller.signal.aborted) return
        writeGatewaySettings(next)
        setSettings(next)
        setRuntime(nextRuntime)
        setError(null)
        qc.clear()
        setEpoch((value) => value + 1)
      } catch (applyError) {
        if (controller.signal.aborted) return
        setError(errorMessage(applyError, 'не удалось применить настройки гейтвея'))
        throw applyError
      } finally {
        if (applyControllerRef.current === controller) applyControllerRef.current = null
      }
    },
    [qc],
  )

  const value = useMemo<GatewayContextValue>(
    () => ({ settings, runtime, epoch, ready, error, apply }),
    [apply, settings, runtime, epoch, ready, error],
  )

  if (!ready) return <div className="h-dvh bg-ink" />

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>
}
