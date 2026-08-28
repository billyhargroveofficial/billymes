import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type CSSProperties } from 'react'
import { ModelPicker, modelKeys, modelSelectionApi } from '@/features/model-selection'
import { metaFor, profileApi, profileKeys, useProfileScope } from '@/features/profiles'
import { errorMessage } from '@/shared/lib/error-message'
import { cn } from '@/shared/lib/cn'
import { Markdown } from '@/shared/ui/Markdown'
import { Notice } from '@/shared/ui/notice'
import { Skeleton, SkeletonBlock, SkeletonText } from '@/shared/ui/skeleton'
import { Rise, StaggerItem, SwapPane } from '@/shared/ui/motion'
import { EmptyHint } from '@/shared/ui/page'
import { ProfileModelSettings } from './ProfileModelSettings'

type SealMeta = {
  label: string
  kicker: string
  from: string
  to: string
}

function pluralRu(count: number, forms: readonly [string, string, string]) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/**
 * The station seal: one gradient disc in the profile's identity colours.
 * `ring` marks the station currently at the desk — the CSS side breathes a
 * thin ring only for `[data-active='true']`.
 */
function Seal({
  meta,
  size,
  text,
  ring = false,
}: {
  meta: SealMeta
  size: string
  text: string
  ring?: boolean
}) {
  return (
    <span
      className={cn('profile-seal shrink-0', size)}
      data-active={ring ? 'true' : undefined}
      style={{ '--seal-from': meta.from, '--seal-to': meta.to } as CSSProperties}
    >
      <span className={cn('font-display italic text-on-bubble', text)}>
        {meta.label.slice(0, 1)}
      </span>
    </span>
  )
}

/** One spec-strip cell: mono value over a micro label, quiet by design. */
function Spec({
  value,
  label,
  ok = false,
  separated = false,
}: {
  value: string
  label: string
  ok?: boolean
  separated?: boolean
}) {
  return (
    <div className={cn('flex min-w-0 flex-col', separated && 'border-l border-line/40 pl-4')}>
      <span className={cn('truncate font-mono text-sm', ok ? 'text-ok' : 'text-paper')}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.14em] text-mute/80">{label}</span>
    </div>
  )
}

function StationCard({
  name,
  description,
  provider,
  model,
  skillCount,
  gatewayRunning,
  hasEnv,
  isDefault,
  active,
  onSelect,
  onAssign,
}: {
  name: string
  description: string
  provider: string | null
  model: string | null
  skillCount: number
  gatewayRunning: boolean
  hasEnv: boolean
  isDefault: boolean
  active: boolean
  onSelect: (name: string) => void
  onAssign: (name: string) => (provider: string, model: string) => Promise<void>
}) {
  const meta = metaFor(name)
  return (
    <article
      data-selected={active}
      className="card-interactive group relative flex h-full flex-col justify-between overflow-hidden rounded-3xl border border-line bg-panel/40 p-4 text-left"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px opacity-40 transition-opacity duration-300 group-hover:opacity-100 group-data-[selected=true]:opacity-90"
        style={{
          background: `linear-gradient(90deg, transparent, ${meta.from}, ${meta.to}, transparent)`,
        }}
      />
      <button
        type="button"
        aria-pressed={active}
        className="w-full text-left"
        onClick={() => onSelect(name)}
      >
        <div className="flex items-start gap-3">
          <Seal meta={meta} ring={active} size="size-12" text="text-lg" />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2">
              <div className="truncate font-display text-xl italic text-paper">{meta.label}</div>
              <SwapPane pane={active ? 'at-desk' : 'away'} className="ml-auto shrink-0">
                {active && (
                  <span className="inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-accent-ink">
                    за столом
                  </span>
                )}
              </SwapPane>
            </div>
            <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
              {meta.kicker}
              {isDefault ? ' · по умолчанию' : ''}
            </div>
          </div>
        </div>
        <p className="mt-3 line-clamp-2 min-h-10 text-sm text-mute">{description || provider}</p>
        <div className="mt-3 flex items-stretch gap-4 border-t border-line/60 pt-3">
          <Spec value={String(skillCount)} label="навыки" />
          <Spec
            value={gatewayRunning ? 'живёт' : 'спит'}
            label="шлюз"
            ok={gatewayRunning}
            separated
          />
          <Spec value={hasEnv ? 'есть' : 'нет'} label="env" separated />
        </div>
      </button>
      <div className="mt-3">
        <div className="flex items-center justify-between gap-2 border-t border-line/60 pt-3">
          <span className="text-[10px] uppercase tracking-[0.16em] text-mute">основная модель</span>
          <ModelPicker
            profile={name}
            model={model ?? ''}
            provider={provider ?? ''}
            onPick={(pickedProvider, pickedModel) =>
              void onAssign(name)(pickedProvider, pickedModel)
            }
          />
        </div>
        <ProfileModelSettings profile={name} model={model ?? ''} provider={provider ?? ''} />
      </div>
    </article>
  )
}

function GridSkeleton() {
  return (
    <SkeletonBlock label="загружаем профили" className="grid gap-4 md:grid-cols-2">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="rounded-3xl border border-line bg-panel/40 p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <Skeleton className="mt-4 h-4 w-3/4" />
          <Skeleton className="mt-4 h-9 rounded-xl" />
          <Skeleton className="mt-3 h-4 w-40" />
        </div>
      ))}
    </SkeletonBlock>
  )
}

/**
 * The soul manuscript for the station at the desk. The plate crossfades when
 * the station changes; its top rule wears the station's identity gradient.
 */
function SoulPanel({ profile, className }: { profile: string; className?: string }) {
  const meta = metaFor(profile)
  const soul = useQuery({
    queryKey: ['soul', profile],
    queryFn: () => profileApi.soul(profile),
  })
  return (
    <section aria-label={`soul.md профиля ${meta.label}`} className={className}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-mute">soul.md</div>
      <SwapPane pane={profile} className="mt-3">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-panel/40 p-5">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-px opacity-60"
            style={{
              background: `linear-gradient(90deg, transparent, ${meta.from}, ${meta.to}, transparent)`,
            }}
          />
          <div className="flex items-center gap-2.5">
            <Seal meta={meta} size="size-8" text="text-sm" />
            <div className="min-w-0">
              <div className="truncate font-display text-lg italic text-mercury">{meta.label}</div>
              <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
                {meta.kicker}
              </div>
            </div>
          </div>
          <div
            aria-hidden="true"
            className="mt-3 h-px opacity-40"
            style={{
              background: `linear-gradient(90deg, ${meta.from}, ${meta.to} 40%, transparent)`,
            }}
          />
          <div className="mt-4">
            {soul.isPending ? (
              <SkeletonText lines={10} />
            ) : soul.error ? (
              <Notice>{errorMessage(soul.error, 'не удалось загрузить soul')}</Notice>
            ) : soul.data?.content ? (
              <Markdown text={soul.data.content} />
            ) : (
              <p className="text-sm text-mute">soul.md пока пуст</p>
            )}
          </div>
        </div>
      </SwapPane>
    </section>
  )
}

export function ProfilesPage() {
  const { profile, setProfile, profiles, profilesLoading, status } = useProfileScope()
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)

  const assignFor = (name: string) => async (provider: string, model: string) => {
    setActionError(null)
    try {
      await modelSelectionApi.setProfileMainModel(name, provider, model)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
        queryClient.invalidateQueries({ queryKey: profileKeys.config(name) }),
      ])
    } catch (error) {
      setActionError(errorMessage(error, 'не удалось назначить модель профилю'))
    }
  }

  const gatewayRunning = status?.gateway_running ?? false
  const totalSkills = profiles.reduce((sum, item) => sum + item.skill_count, 0)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 p-4 md:p-6 lg:overflow-y-auto">
        <Rise>
          <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] text-mute">дом</div>
              <h1 className="font-display text-3xl italic text-mercury">профили</h1>
            </div>
            {profiles.length > 0 && (
              <div className="flex items-center gap-2 font-mono text-[11px] text-mute">
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    gatewayRunning ? 'bg-ok pulse-soft' : 'bg-mute',
                  )}
                />
                <span>
                  {profiles.length} {pluralRu(profiles.length, ['станция', 'станции', 'станций'])} ·{' '}
                  {totalSkills} {pluralRu(totalSkills, ['навык', 'навыка', 'навыков'])} ·{' '}
                  {gatewayRunning ? 'шлюз живёт' : 'шлюз спит'}
                </span>
              </div>
            )}
          </header>
        </Rise>
        {actionError && <Notice className="mb-3">{actionError}</Notice>}
        {profilesLoading ? (
          <GridSkeleton />
        ) : profiles.length === 0 ? (
          <EmptyHint>станций нет</EmptyHint>
        ) : (
          <div className="grid auto-rows-fr gap-4 md:grid-cols-2">
            {profiles.map((item, index) => (
              <StaggerItem key={item.name} index={index} className="h-full">
                <StationCard
                  name={item.name}
                  description={item.description}
                  provider={item.provider}
                  model={item.model}
                  skillCount={item.skill_count}
                  gatewayRunning={item.gateway_running}
                  hasEnv={item.has_env}
                  isDefault={item.is_default}
                  active={item.name === profile}
                  onSelect={setProfile}
                  onAssign={assignFor}
                />
              </StaggerItem>
            ))}
          </div>
        )}
        <SoulPanel profile={profile} className="mt-8 lg:hidden" />
      </div>
      <aside className="hidden w-[28rem] shrink-0 border-l border-line p-5 lg:block lg:overflow-y-auto">
        <SoulPanel profile={profile} />
      </aside>
    </div>
  )
}
