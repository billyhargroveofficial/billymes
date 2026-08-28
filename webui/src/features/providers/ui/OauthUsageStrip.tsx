import { useQuery } from '@tanstack/react-query'
import { cn } from '@/shared/lib/cn'
import { providersApi } from '../api/providers-api'
import { accountUsageChips } from '../model/account-usage-view'
import { providerKeys } from '../model/provider-keys'

/** The upstream call fans out to provider billing APIs — poll gently. */
const REFRESH_MS = 5 * 60_000

/**
 * Header ornament: one quiet chip per connected OAuth subscription showing
 * how much of its limit is already spent («13% сессия»). Renders nothing
 * while loading, on error, or when no metered account is connected — the
 * chat desk header must never grow a failure state of its own.
 */
export function OauthUsageStrip({ profile, className }: { profile: string; className?: string }) {
  const usage = useQuery({
    queryKey: providerKeys.accountUsage(profile),
    queryFn: () => providersApi.accountUsage(profile),
    staleTime: 60_000,
    refetchInterval: REFRESH_MS,
  })
  if (!usage.data) return null
  const chips = accountUsageChips(usage.data)
  if (chips.length === 0) return null
  return (
    <div className={cn('min-w-0 items-center gap-2 overflow-hidden', className)}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          title={chip.tooltip}
          className="inline-flex min-w-0 items-baseline gap-1.5 rounded-full border border-line bg-raised px-2.5 py-1 font-mono text-[11px] text-mute md:text-[10px]"
        >
          <span className="truncate text-paper">{chip.name}</span>
          {chip.plan && <span className="shrink-0">{chip.plan.toLowerCase()}</span>}
          <span className={cn('shrink-0 tabular-nums', chip.warn ? 'text-ember' : 'text-mercury')}>
            {chip.summary}
          </span>
        </span>
      ))}
    </div>
  )
}
