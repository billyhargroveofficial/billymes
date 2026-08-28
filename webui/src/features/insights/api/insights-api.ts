import { requestJson, withProfile } from '@/shared/api'
import { parseSessionStats, parseSystemStats } from './parse-host'
import { parseModelReport, parseUsageReport } from './parse-usage'

/** Query keys for every analytics surface, scoped by profile and window. */
export const insightsKeys = {
  usage: (profile: string, days: number) => ['insights-usage', profile, days] as const,
  models: (profile: string, days: number) => ['insights-models', profile, days] as const,
  sessions: (profile: string) => ['insights-sessions', profile] as const,
  system: () => ['insights-system'] as const,
}

function clampDays(days: number) {
  if (!Number.isFinite(days)) return 30
  return Math.min(365, Math.max(1, Math.round(days)))
}

export const insightsApi = {
  usage: async (profile: string, days: number) => {
    const window = clampDays(days)
    const payload = await requestJson(
      withProfile(`/api/analytics/usage?days=${window}`, profile),
      {},
      { timeoutMs: 45_000 },
    )
    return parseUsageReport(payload, window)
  },
  models: async (profile: string, days: number) => {
    const window = clampDays(days)
    const payload = await requestJson(withProfile(`/api/analytics/models?days=${window}`, profile))
    return parseModelReport(payload, window)
  },
  sessions: async (profile: string) =>
    parseSessionStats(await requestJson(withProfile('/api/sessions/stats', profile))),
  system: async () => parseSystemStats(await requestJson('/api/system/stats')),
}
