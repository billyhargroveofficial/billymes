import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrainCircuit, Check, Eye, KeyRound, Search, Wrench, Zap } from 'lucide-react'
import { useState } from 'react'
import { metaFor, useProfileScope } from '@/features/profiles'
import {
  modelKeys,
  modelSelectionApi,
  type ModelCapability,
  type ProviderOption,
} from '@/features/model-selection'
import { cn } from '@/shared/lib/cn'
import { combinedErrorMessage, errorMessage } from '@/shared/lib/error-message'
import { Badge } from '@/shared/ui/badge'
import { Rise, StaggerItem, SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, PageShell, SectionCard } from '@/shared/ui/page'
import { Skeleton, SkeletonBlock, SkeletonCards } from '@/shared/ui/skeleton'
import { Spinner } from '@/shared/ui/spinner'

const EMPTY_PROVIDERS: ProviderOption[] = []

type ModelEntry = {
  id: string
  contextWindow?: number
  capability?: ModelCapability
}

function modelEntries(provider: ProviderOption): ModelEntry[] {
  return provider.models.map((raw) => {
    const id = typeof raw === 'string' ? raw : raw.id
    const contextWindow = typeof raw === 'string' ? undefined : raw.context_window
    const capability = provider.capabilities?.[id]
    return {
      id,
      ...(contextWindow ? { contextWindow } : {}),
      ...(capability ? { capability } : {}),
    }
  })
}

function fmtCtx(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export function ModelsPage() {
  const { profile } = useProfileScope()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const options = useQuery({
    queryKey: modelKeys.options(profile),
    queryFn: () => modelSelectionApi.options(profile),
  })
  const info = useQuery({
    queryKey: modelKeys.info(profile),
    queryFn: () => modelSelectionApi.info(profile),
  })
  const aux = useQuery({
    queryKey: modelKeys.auxiliary(profile),
    queryFn: () => modelSelectionApi.auxiliary(profile),
  })

  const activate = useMutation({
    mutationFn: ({ provider, model }: { provider: string; model: string }) =>
      modelSelectionApi.setProfileMainModel(profile, provider, model),
    onMutate: () => setActionError(null),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
      ])
    },
    onError: (error) => setActionError(errorMessage(error, 'не удалось переключить модель')),
  })

  const providers = options.data?.providers ?? EMPTY_PROVIDERS
  const activeProvider = options.data?.provider ?? ''
  const activeModel = options.data?.model ?? ''
  const needle = q.trim().toLowerCase()
  const pane = options.isPending ? 'skeleton' : options.error ? 'error' : 'ready'

  return (
    <PageShell
      eyebrow="слоты"
      title="модели"
      actions={
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute"
          />
          <input
            type="search"
            name="model-search"
            autoComplete="off"
            aria-label="фильтр моделей"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="найти модель…"
            className="h-10 w-full rounded-xl border border-line bg-ink/60 pl-9 pr-3 text-sm transition-colors placeholder:text-mute/70 md:w-64"
          />
        </div>
      }
    >
      {(options.error || aux.error) && (
        <Notice className="mb-4">
          {combinedErrorMessage(
            [options.error, 'не удалось загрузить список моделей'],
            [aux.error, 'не удалось загрузить auxiliary-модели'],
          )}
        </Notice>
      )}
      {actionError && <Notice className="mb-4">{actionError}</Notice>}

      {options.isPending ? (
        <SkeletonBlock
          label="загружаем активную модель"
          className="rounded-3xl border border-line bg-panel/40 p-5"
        >
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-8 w-72" />
          <Skeleton className="mt-3 h-3 w-56" />
        </SkeletonBlock>
      ) : (
        !options.error && (
          <Rise>
            <section className="relative overflow-hidden rounded-3xl border border-line bg-panel/40 p-5">
              <div
                aria-hidden="true"
                className="aurora aurora-warm -right-10 -top-16 size-64 opacity-70"
              />
              <div className="relative">
                <div className="text-[10px] uppercase tracking-[0.2em] text-mute">
                  сейчас у профиля {metaFor(profile).label}
                </div>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="break-all font-display text-3xl italic leading-none text-mercury">
                    {activeModel || '—'}
                  </h2>
                  <span className="font-mono text-xs text-mute">{activeProvider}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {info.data?.capabilities.supports_reasoning && (
                    <CapChip icon={<BrainCircuit className="size-3" />} label="рассуждает" />
                  )}
                  {info.data?.capabilities.supports_vision && (
                    <CapChip icon={<Eye className="size-3" />} label="видит" />
                  )}
                  {info.data?.capabilities.supports_tools && (
                    <CapChip icon={<Wrench className="size-3" />} label="тулы" />
                  )}
                  {info.data?.effective_context_length ? (
                    <CapChip label={`контекст ${fmtCtx(info.data.effective_context_length)}`} />
                  ) : null}
                  {info.data?.capabilities.max_output_tokens ? (
                    <CapChip label={`вывод ${fmtCtx(info.data.capabilities.max_output_tokens)}`} />
                  ) : null}
                  {info.data?.capabilities.model_family && (
                    <CapChip label={info.data.capabilities.model_family} />
                  )}
                </div>
              </div>
            </section>
          </Rise>
        )
      )}

      <SwapPane pane={pane}>
        {pane === 'skeleton' ? (
          <SkeletonCards
            count={9}
            height="h-16"
            label="загружаем модели"
            className="mt-8 md:grid-cols-2 xl:grid-cols-3"
          />
        ) : (
          <div>
            {providers.map((prov) => {
              const entries = modelEntries(prov).filter((entry) =>
                needle
                  ? `${prov.slug} ${prov.name} ${entry.id}`.toLowerCase().includes(needle)
                  : true,
              )
              if (!entries.length) return null
              return (
                <section key={prov.slug} className="mt-8">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 rounded-full',
                        prov.authenticated ? 'bg-ok/80' : 'bg-ember',
                      )}
                    />
                    <h2 className="text-[11px] uppercase tracking-[0.18em] text-mute">
                      {prov.name}
                    </h2>
                    {prov.is_current && <Badge>current</Badge>}
                    {!prov.authenticated && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-ember">
                        <KeyRound className="size-3" /> нет доступа
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] tabular-nums text-mute/70">
                      {entries.length}
                      {typeof prov.total_models === 'number' && prov.total_models > entries.length
                        ? ` из ${prov.total_models}`
                        : ''}
                    </span>
                  </div>
                  {prov.warning && (
                    <p className="mb-3 max-w-2xl text-xs leading-5 text-mute">{prov.warning}</p>
                  )}
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {entries.slice(0, 60).map((entry, index) => {
                      const active = entry.id === activeModel && prov.is_current
                      const pending =
                        activate.isPending &&
                        activate.variables?.model === entry.id &&
                        activate.variables.provider === prov.slug
                      return (
                        <StaggerItem key={entry.id} index={index}>
                          <button
                            type="button"
                            data-selected={active}
                            disabled={activate.isPending || active}
                            title={
                              active ? 'активная модель' : `сделать ${entry.id} основной моделью`
                            }
                            onClick={() =>
                              activate.mutate({ provider: prov.slug, model: entry.id })
                            }
                            className={cn(
                              'card-interactive flex w-full items-center gap-3 rounded-2xl border border-line bg-ink/30 p-3 text-left disabled:pointer-events-none',
                              active && 'border-accent/45 bg-accent-soft',
                              !active && activate.isPending && !pending && 'opacity-60',
                            )}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-sm">{entry.id}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-mute">
                                {entry.capability?.fast && (
                                  <span className="inline-flex items-center gap-0.5">
                                    <Zap aria-hidden="true" className="size-3 text-mercury/80" />
                                    быстрая
                                  </span>
                                )}
                                {entry.capability?.reasoning && (
                                  <span className="inline-flex items-center gap-0.5">
                                    <BrainCircuit
                                      aria-hidden="true"
                                      className="size-3 text-mercury/80"
                                    />
                                    рассуждает
                                  </span>
                                )}
                                {entry.contextWindow ? (
                                  <span className="font-mono">{fmtCtx(entry.contextWindow)}</span>
                                ) : null}
                              </div>
                            </div>
                            {pending ? (
                              <Spinner className="text-mercury" />
                            ) : active ? (
                              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
                                <Check aria-hidden="true" className="size-3" />
                              </span>
                            ) : null}
                          </button>
                        </StaggerItem>
                      )
                    })}
                  </div>
                </section>
              )
            })}
            {needle &&
              providers.every(
                (prov) =>
                  !modelEntries(prov).some((entry) =>
                    `${prov.slug} ${prov.name} ${entry.id}`.toLowerCase().includes(needle),
                  ),
              ) && <EmptyHint className="mt-8">по запросу «{q}» ничего не нашлось</EmptyHint>}
          </div>
        )}
      </SwapPane>

      <SectionCard
        title="вспомогательные слоты"
        hint="служебные задачи гейтвея — vision, сжатие, тайтлы; «авто» значит, что Hermes выбирает модель сам"
        className="mt-10"
      >
        {aux.isPending ? (
          <SkeletonCards count={6} height="h-9" label="загружаем auxiliary-модели" />
        ) : (
          <ul className="grid gap-x-6 sm:grid-cols-2 xl:grid-cols-3">
            {(aux.data?.tasks ?? []).map((task) => {
              const auto = !task.model && (task.provider === 'auto' || !task.provider)
              return (
                <li
                  key={task.task}
                  className="flex h-9 items-center gap-2 border-b border-line/40 text-sm last:border-0 sm:[&:nth-last-child(2)]:border-0"
                >
                  <span className="min-w-0 flex-1 truncate">{task.task}</span>
                  {auto ? (
                    <span className="rounded-full border border-line/70 px-2 py-0.5 text-[10px] text-mute">
                      авто
                    </span>
                  ) : (
                    <span className="truncate font-mono text-xs text-mercury">
                      {task.provider}
                      {task.model ? `/${task.model}` : ''}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>
    </PageShell>
  )
}

function CapChip({ icon, label }: { icon?: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line/70 bg-raised/50 px-2 py-0.5 text-[10px] text-paper/80">
      {icon}
      {label}
    </span>
  )
}
