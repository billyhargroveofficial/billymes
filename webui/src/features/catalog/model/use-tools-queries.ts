import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { catalogApi } from '../api/catalog-api'
import { toolsConfigApi } from '../api/tools-config-api'
import { usageCounts, usageIndex } from './tool-usage'

const USAGE_WINDOW_DAYS = 90

/**
 * Every read the Тулы screen makes, in one place so the page component stays
 * about composition. Dependent and panel-only reads are gated with `enabled`
 * — the platform catalog and the config schema are large payloads nobody
 * needs until a набор or the settings panel is open.
 */
export function useToolsQueries({
  profile,
  toolset,
  selectedProvider,
  settingsOpen,
  postSetupRunning,
}: {
  profile: string
  toolset: string | null
  selectedProvider: string | null
  settingsOpen: boolean
  postSetupRunning: boolean
}) {
  const toolsetsQ = useQuery({
    queryKey: ['toolsets', profile],
    queryFn: () => catalogApi.toolsets(profile),
  })
  const usageQ = useQuery({
    queryKey: ['tool-usage', profile],
    queryFn: () => catalogApi.usage(profile, USAGE_WINDOW_DAYS),
  })
  const policyQ = useQuery({
    queryKey: ['tool-policy-config', profile],
    queryFn: () => toolsConfigApi.config(profile),
  })
  const configQ = useQuery({
    queryKey: ['toolset-config', profile, toolset],
    queryFn: () => catalogApi.toolsetConfig(toolset!, profile),
    enabled: Boolean(toolset),
  })

  const effectiveProvider =
    selectedProvider ??
    configQ.data?.activeProvider ??
    configQ.data?.providers.find((provider) => provider.isActive)?.name ??
    null

  const modelsQ = useQuery({
    queryKey: ['toolset-models', profile, toolset, effectiveProvider],
    queryFn: () => catalogApi.toolsetModels(toolset!, effectiveProvider, profile),
    enabled: Boolean(toolset && configQ.data),
  })
  const platformsQ = useQuery({
    queryKey: ['messaging-platforms', profile],
    queryFn: () => toolsConfigApi.messagingPlatforms(profile),
    enabled: Boolean(toolset) || settingsOpen,
  })
  const schemaQ = useQuery({
    queryKey: ['config-schema'],
    queryFn: () => toolsConfigApi.schema(),
    enabled: settingsOpen,
  })
  const backendsQ = useQuery({
    queryKey: ['terminal-backends', profile],
    queryFn: () => toolsConfigApi.terminalBackends(profile),
    enabled: settingsOpen,
  })
  const computerUseQ = useQuery({
    queryKey: ['computer-use', profile],
    queryFn: () => toolsConfigApi.computerUse(profile),
    enabled: settingsOpen,
  })
  const postSetupQ = useQuery({
    queryKey: ['tools-post-setup-status'],
    queryFn: () => toolsConfigApi.postSetupStatus(),
    enabled: postSetupRunning,
    refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
  })

  const usage = useMemo(() => usageIndex(usageQ.data?.tools ?? []), [usageQ.data])
  const counts = useMemo(() => usageCounts(usage), [usage])

  return {
    toolsetsQ,
    usageQ,
    policyQ,
    configQ,
    modelsQ,
    platformsQ,
    schemaQ,
    backendsQ,
    computerUseQ,
    postSetupQ,
    effectiveProvider,
    usage,
    counts,
  }
}
