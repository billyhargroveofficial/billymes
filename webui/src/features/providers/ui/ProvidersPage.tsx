import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Layers, LogIn, RefreshCw, Server, type LucideIcon } from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { m } from '@/shared/ui/motion'
import { PageShell, SectionCard } from '@/shared/ui/page'
import { providersApi } from '../api/providers-api'
import { countSetEnvVars } from '../model/env-groups'
import { connectedCount } from '../model/oauth-view'
import { poolEntryCount, poolProviderSuggestions } from '../model/pool-view'
import { providerKeys } from '../model/provider-keys'
import type { CustomEndpointsPayload, EnvVar, OauthProvider, PoolProvider } from '../model/types'
import { CredentialPoolList } from './CredentialPoolList'
import { CustomEndpointList } from './CustomEndpointList'
import { EnvKeyList } from './EnvKeyList'
import { OauthProviderList } from './OauthProviderList'

const NO_OAUTH: OauthProvider[] = []
const NO_ENV: EnvVar[] = []
const NO_POOL: PoolProvider[] = []

/**
 * Every credential the agent can use, in one place: OAuth logins, `.env` API
 * keys, the credential pool, and custom OpenAI-compatible endpoints.
 */
export function ProvidersPage() {
  const { profile } = useProfileScope()
  const qc = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const query = searchParams.get('q') ?? ''
  const showAdvanced = searchParams.get('adv') === '1'
  const openCategory = searchParams.get('cat')

  const oauthQ = useQuery({
    queryKey: providerKeys.oauth(profile),
    queryFn: () => providersApi.oauthProviders(profile),
  })
  const envQ = useQuery({
    queryKey: providerKeys.env(profile),
    queryFn: () => providersApi.envVars(profile),
  })
  const poolQ = useQuery({
    queryKey: providerKeys.pool(),
    queryFn: () => providersApi.credentialPool(),
  })
  const endpointsQ = useQuery({
    queryKey: providerKeys.endpoints(profile),
    queryFn: () => providersApi.customEndpoints(profile),
  })

  const oauth: OauthProvider[] = oauthQ.data ?? NO_OAUTH
  const envVars: EnvVar[] = envQ.data ?? NO_ENV
  const pool: PoolProvider[] = poolQ.data ?? NO_POOL
  const endpoints: CustomEndpointsPayload | undefined = endpointsQ.data

  const connected = useMemo(() => connectedCount(oauth), [oauth])
  const setKeys = useMemo(() => countSetEnvVars(envVars), [envVars])
  const pooled = useMemo(() => poolEntryCount(pool), [pool])
  const suggestions = useMemo(
    () => poolProviderSuggestions(pool, oauth, envVars),
    [envVars, oauth, pool],
  )

  const updateRouteState = useCallback(
    (values: Partial<Record<'q' | 'adv' | 'cat', string | null>>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          for (const [key, value] of Object.entries(values)) {
            if (value) next.set(key, value)
            else next.delete(key)
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const onQueryChange = useCallback(
    (value: string) => updateRouteState({ q: value }),
    [updateRouteState],
  )
  const onShowAdvancedChange = useCallback(
    (value: boolean) => updateRouteState({ adv: value ? '1' : null }),
    [updateRouteState],
  )
  const onOpenCategory = useCallback(
    (category: string | null) => updateRouteState({ cat: category }),
    [updateRouteState],
  )

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerKeys.oauth(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.env(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.pool() })
    void qc.invalidateQueries({ queryKey: providerKeys.endpoints(profile) })
  }, [profile, qc])

  const oauthError = oauthQ.error ? errorMessage(oauthQ.error, 'не удалось загрузить входы') : null
  const envError = envQ.error ? errorMessage(envQ.error, 'не удалось загрузить ключи') : null
  const poolError = poolQ.error ? errorMessage(poolQ.error, 'не удалось загрузить пул') : null
  const endpointsError = endpointsQ.error
    ? errorMessage(endpointsQ.error, 'не удалось загрузить эндпоинты')
    : null

  const anyPending = oauthQ.isPending || envQ.isPending || poolQ.isPending || endpointsQ.isPending

  return (
    <PageShell
      eyebrow="связка ключей"
      title="доступы"
      actions={
        <Button type="button" variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw
            aria-hidden="true"
            className={cn('size-3.5', anyPending && 'animate-spin motion-reduce:animate-none')}
          />
          обновить
        </Button>
      }
    >
      <div className="relative mb-5 overflow-hidden rounded-3xl border border-line bg-panel/40">
        <div
          aria-hidden="true"
          className="aurora aurora-warm -right-12 -top-20 size-64 opacity-60"
        />
        <div className="relative grid grid-cols-2 divide-line/50 xl:grid-cols-4 xl:divide-x">
          <HeroStat
            icon={LogIn}
            value={connected}
            label="входов"
            caption={`из ${oauth.length} подключено`}
            tone={connected > 0 ? 'ok' : 'mute'}
            target="sec-oauth"
          />
          <HeroStat
            icon={KeyRound}
            value={setKeys}
            label="ключей"
            caption={`из ${envVars.length} задано`}
            tone="paper"
            target="sec-env"
          />
          <HeroStat
            icon={Layers}
            value={pooled}
            label="в пуле"
            caption={`${pool.length} провайдеров`}
            tone="paper"
            target="sec-pool"
          />
          <HeroStat
            icon={Server}
            value={endpoints?.endpoints.length ?? 0}
            label="эндпоинтов"
            caption={endpoints?.current.provider || 'основной не выбран'}
            tone="accent"
            target="sec-endpoints"
          />
        </div>
      </div>

      <div className="space-y-4">
        <SectionCard
          id="sec-oauth"
          icon={<LogIn aria-hidden="true" className="size-3" />}
          title="входы"
          hint="oauth и подписки, которыми агент ходит к провайдерам"
        >
          <OauthProviderList
            profile={profile}
            providers={oauthQ.data}
            pending={oauthQ.isPending}
            loadError={oauthError}
          />
        </SectionCard>

        <SectionCard
          id="sec-env"
          icon={<KeyRound aria-hidden="true" className="size-3" />}
          title="ключи"
          hint="переменные .env профиля: api-ключи, адреса, токены каналов"
        >
          <EnvKeyList
            key={profile}
            profile={profile}
            vars={envQ.data}
            pending={envQ.isPending}
            loadError={envError}
            query={query}
            onQueryChange={onQueryChange}
            showAdvanced={showAdvanced}
            onShowAdvancedChange={onShowAdvancedChange}
            openCategory={openCategory}
            onOpenCategory={onOpenCategory}
          />
        </SectionCard>

        <SectionCard
          id="sec-pool"
          icon={<Layers aria-hidden="true" className="size-3" />}
          title="пул ключей"
          hint="несколько ключей на провайдера — агент чередует их"
        >
          <CredentialPoolList
            profile={profile}
            pool={poolQ.data}
            suggestions={suggestions}
            pending={poolQ.isPending}
            loadError={poolError}
          />
        </SectionCard>

        <SectionCard
          id="sec-endpoints"
          icon={<Server aria-hidden="true" className="size-3" />}
          title="свои эндпоинты"
          hint="openai-совместимые адреса: локальные и сторонние"
        >
          <CustomEndpointList
            profile={profile}
            payload={endpointsQ.data}
            pending={endpointsQ.isPending}
            loadError={endpointsError}
          />
        </SectionCard>
      </div>
    </PageShell>
  )
}

const HERO_POP = { opacity: 0, y: 7 }
const HERO_SETTLED = { opacity: 1, y: 0 }

/**
 * One headline number in the hero band. It doubles as navigation: the click
 * scrolls to the section it summarises. The value remounts on change and pops
 * in, which is what makes the band read as live.
 */
function HeroStat({
  icon: Icon,
  value,
  label,
  caption,
  tone,
  target,
}: {
  icon: LucideIcon
  value: number
  label: string
  caption: string
  tone: 'ok' | 'accent' | 'paper' | 'mute'
  target: string
}) {
  return (
    <button
      type="button"
      onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' })}
      className="group flex items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised/40 sm:px-5"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line/70 bg-raised/50 text-mercury transition-colors group-hover:border-accent/40">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <m.span
            key={value}
            initial={HERO_POP}
            animate={HERO_SETTLED}
            className={cn(
              'font-display text-2xl italic leading-none',
              tone === 'ok' && value > 0
                ? 'text-ok'
                : tone === 'accent'
                  ? 'text-mercury'
                  : tone === 'mute'
                    ? 'text-mute'
                    : 'text-paper',
            )}
          >
            {value}
          </m.span>
          <span className="text-[10px] uppercase tracking-[0.16em] text-mute">{label}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-mute/80">{caption}</span>
      </span>
    </button>
  )
}
