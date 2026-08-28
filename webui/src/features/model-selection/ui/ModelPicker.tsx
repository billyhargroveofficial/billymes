import * as Dropdown from '@radix-ui/react-dropdown-menu'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Skeleton, SkeletonBlock } from '@/shared/ui/skeleton'
import { modelSelectionApi } from '../api/model-selection-api'
import { modelKeys } from '../model/model-keys'
import { modelList } from '../model/model-list'
import { REASONING_LEVELS } from '../model/reasoning-levels'

export function ModelPicker({
  profile,
  model,
  provider,
  onPick,
  compact,
}: {
  profile?: string
  model: string
  provider: string
  onPick: (provider: string, model: string) => void
  compact?: boolean
}) {
  const options = useQuery({
    queryKey: modelKeys.options(profile),
    queryFn: () => modelSelectionApi.options(profile),
  })
  const providers = options.data?.providers ?? []
  const modelCount = providers.reduce((total, prov) => total + modelList(prov.models).length, 0)
  const label = model || 'модель'

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          aria-label={`выбрать модель, сейчас ${label}`}
          className={cn(
            'inline-flex max-w-[11rem] items-center gap-1 truncate rounded-full border border-line bg-raised/70 px-2.5 py-1 text-left font-mono text-[11px] text-paper hover:bg-raised',
            compact && 'max-w-[9.5rem] px-2',
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-mute" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          sideOffset={8}
          align="start"
          className="z-50 max-h-80 w-72 overflow-y-auto rounded-2xl border border-line bg-panel p-1 shadow-desk"
        >
          {options.isPending && (
            <SkeletonBlock label="загружаем модели" className="space-y-1.5 px-2 py-2">
              {[0, 1, 2, 3, 4].map((row) => (
                <Skeleton key={row} className="h-4" style={{ width: `${88 - row * 12}%` }} />
              ))}
            </SkeletonBlock>
          )}
          {options.error && (
            <Dropdown.Item disabled className="px-2 py-1.5 text-xs text-ember">
              {errorMessage(options.error, 'модели недоступны')}
            </Dropdown.Item>
          )}
          {providers.map((prov) => (
            <div key={prov.slug} className="py-1">
              <div className="px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-mute">
                {prov.name}
              </div>
              {modelList(prov.models).map((id) => (
                <Dropdown.Item
                  key={`${prov.slug}-${id}`}
                  className={cn(
                    'cursor-pointer rounded-xl px-2 py-1.5 font-mono text-xs outline-none hover:bg-raised data-[highlighted]:bg-raised data-[highlighted]:text-paper',
                    id === model && prov.slug === provider && 'text-mercury',
                  )}
                  onSelect={() => onPick(prov.slug, id)}
                >
                  {id}
                </Dropdown.Item>
              ))}
            </div>
          ))}
          {!options.isPending && !options.error && modelCount === 0 && (
            <Dropdown.Item disabled className="px-2 py-1.5 text-xs text-mute">
              моделей нет
            </Dropdown.Item>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}

export function ReasoningPicker({
  value,
  onPick,
  canDisable = true,
  disabled = false,
}: {
  value: string
  onPick: (level: string) => void
  canDisable?: boolean
  disabled?: boolean
}) {
  const current = value || 'default'
  const levels = canDisable
    ? REASONING_LEVELS
    : REASONING_LEVELS.filter((level) => level !== 'none')
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`уровень рассуждений, сейчас ${current}`}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-raised/70 px-2.5 py-1 font-mono text-[11px] text-paper hover:bg-raised"
        >
          {current}
          <ChevronDown aria-hidden="true" className="size-3 text-mute" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          sideOffset={8}
          className="z-50 w-36 rounded-2xl border border-line bg-panel p-1 shadow-desk"
        >
          {levels.map((level) => (
            <Dropdown.Item
              key={level}
              className={cn(
                'cursor-pointer rounded-xl px-2 py-1.5 text-xs outline-none hover:bg-raised data-[highlighted]:bg-raised data-[highlighted]:text-paper',
                level === value && 'text-mercury',
              )}
              onSelect={() => onPick(level)}
            >
              {level}
            </Dropdown.Item>
          ))}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  )
}
