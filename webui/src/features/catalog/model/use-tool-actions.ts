import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { toolsConfigApi } from '../api/tools-config-api'
import type { ToolPolicyConfig } from './types'

/**
 * Mutations for the Тулы screen: one busy key at a time, one error slot, and
 * a single invalidation set so a save is always reflected everywhere it shows.
 */
export function useToolActions({ profile, toolset }: { profile: string; toolset: string | null }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, fallback: string) => {
      setBusy(key)
      setError(null)
      try {
        await action()
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['toolsets', profile] }),
          qc.invalidateQueries({ queryKey: ['tool-policy-config', profile] }),
          qc.invalidateQueries({ queryKey: ['toolset-config', profile, toolset] }),
          qc.invalidateQueries({ queryKey: ['toolset-models', profile, toolset] }),
          qc.invalidateQueries({ queryKey: ['terminal-backends', profile] }),
          qc.invalidateQueries({ queryKey: ['computer-use', profile] }),
        ])
        return true
      } catch (caught) {
        setError(errorMessage(caught, fallback))
        return false
      } finally {
        setBusy(null)
      }
    },
    [profile, qc, toolset],
  )

  /**
   * Read-modify-write against the live agent configuration.
   *
   * The config is re-read from the gateway inside the action, never taken
   * from the cached query: `PUT /api/config` deep-merges maps but replaces
   * lists outright, so writing a list derived from a stale read would silently
   * revert whatever changed in between. `build` returns `null` when the change
   * is a no-op or unsafe, and then nothing is sent at all.
   */
  const patchPolicy = useCallback(
    (
      key: string,
      build: (config: ToolPolicyConfig) => Record<string, unknown> | null,
      fallback: string,
    ) =>
      run(
        key,
        async () => {
          const fresh = await toolsConfigApi.config(profile)
          const patch = build(fresh)
          if (patch) await toolsConfigApi.patchConfig(patch, profile)
        },
        fallback,
      ),
    [profile, run],
  )

  return { busy, error, notice, setError, setNotice, run, patchPolicy }
}
