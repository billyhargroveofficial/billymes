import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { memo, useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Notice } from '@/shared/ui/notice'
import { memoryApi } from '../api/memory-api'
import type { MemoryProvider, MemoryProviderStatus } from '../model/types'
import { ProviderConfigForm, ProviderOauth } from './ProviderSetup'

const STATUS_LABEL: Record<MemoryProviderStatus, string> = {
  ready: 'готов',
  needs_config: 'нужна настройка',
  unavailable: 'недоступен',
}

const STATUS_TONE: Record<MemoryProviderStatus, string> = {
  ready: 'text-ok',
  needs_config: 'text-mercury',
  unavailable: 'text-mute',
}

const STATUS_DOT: Record<MemoryProviderStatus, string> = {
  ready: 'bg-ok',
  needs_config: 'bg-mercury',
  unavailable: 'bg-mute/60',
}

/**
 * One memory backend as a card in the grid. The active one is warmed by an
 * aurora and its own hairline so the choice is visible without reading the
 * badge; the setup form unfolds inside the card rather than in a dialog.
 */
export const ProviderCard = memo(function ProviderCard({
  provider,
  active,
  profile,
  expanded,
  onExpand,
}: {
  provider: MemoryProvider
  active: boolean
  profile: string
  expanded: boolean
  onExpand: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const name = provider.name

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['memory', 'status'] })

  const activate = useMutation({
    mutationFn: () => memoryApi.selectProvider(name),
    onSuccess: () => void invalidateStatus(),
    onError: (error) => setFailure(errorMessage(error, 'не удалось переключить бэкенд')),
  })
  const install = useMutation({
    mutationFn: () => memoryApi.setupProvider(name),
    onSuccess: () => void invalidateStatus(),
    onError: (error) => setFailure(errorMessage(error, 'не удалось доустановить зависимости')),
  })

  return (
    <div
      data-selected={String(active)}
      className={cn(
        'card-interactive relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-panel/40 p-4',
        expanded && 'sm:col-span-2 xl:col-span-3',
      )}
    >
      {active && (
        <div
          aria-hidden="true"
          className="aurora aurora-warm -right-10 -top-14 size-44 opacity-70"
        />
      )}

      <div className="relative flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-xl border font-display text-base italic',
            active
              ? 'border-accent/45 bg-accent-soft text-mercury'
              : 'border-line bg-raised/50 text-mute',
          )}
        >
          {name.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-sm text-paper">{name}</span>
            {active && <Badge className="border-accent/50 text-mercury">активный</Badge>}
          </div>
          <span
            className={cn(
              'mt-0.5 flex items-center gap-1.5 text-[11px]',
              STATUS_TONE[provider.status],
            )}
          >
            <span
              aria-hidden="true"
              className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[provider.status])}
            />
            {STATUS_LABEL[provider.status]}
          </span>
        </div>
      </div>

      <p className="relative mt-2.5 line-clamp-3 text-xs leading-5 text-mute">
        {provider.description}
      </p>

      <Requirements provider={provider} />
      {failure && <Notice className="relative mt-2">{failure}</Notice>}

      <div className="relative mt-auto flex flex-wrap items-center gap-2 pt-3">
        {provider.status === 'ready' && !active && (
          <Button size="sm" disabled={activate.isPending} onClick={() => activate.mutate()}>
            {activate.isPending ? 'переключаем…' : 'сделать активной'}
          </Button>
        )}
        {!provider.setup.dependenciesInstalled && (
          <Button
            size="sm"
            variant="outline"
            disabled={install.isPending}
            onClick={() => install.mutate()}
          >
            {install.isPending ? 'ставим…' : 'доустановить'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={expanded}
          onClick={() => onExpand(expanded ? '' : name)}
        >
          {expanded ? 'свернуть' : 'настроить'}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 transition-transform duration-200 motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
          />
        </Button>
      </div>

      {expanded && (
        <div className="relative mt-4 space-y-4 border-t border-line pt-4">
          <ProviderConfigForm key={`${name}:${profile}`} name={name} profile={profile} />
          <ProviderOauth name={name} profile={profile} />
        </div>
      )}
    </div>
  )
})

/** What the backend still needs, as compact chips rather than a definition list. */
function Requirements({ provider }: { provider: MemoryProvider }) {
  const { pipDependencies, externalDependencies, requiredEnv } = provider.setup
  if (!pipDependencies.length && !externalDependencies.length && !requiredEnv.length) return null
  return (
    <ul className="relative mt-2.5 flex flex-wrap gap-1">
      {pipDependencies.map((dependency) => (
        <RequirementChip key={`pip:${dependency}`} kind="pip" text={dependency} />
      ))}
      {externalDependencies.map((dependency) => (
        <RequirementChip
          key={`bin:${dependency.name}`}
          kind="бинарь"
          text={dependency.name}
          {...(dependency.install ? { title: dependency.install } : {})}
        />
      ))}
      {requiredEnv.map((variable) => (
        <RequirementChip key={`env:${variable}`} kind="env" text={variable} />
      ))}
    </ul>
  )
}

function RequirementChip({ kind, text, title }: { kind: string; text: string; title?: string }) {
  return (
    <li
      {...(title ? { title } : {})}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-line/70 bg-raised/40 px-1.5 py-0.5"
    >
      <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-mute/60">{kind}</span>
      <span className="truncate font-mono text-[10px] text-mute">{text}</span>
    </li>
  )
}
