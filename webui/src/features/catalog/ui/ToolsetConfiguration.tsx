import { Check } from 'lucide-react'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, SectionCard } from '@/shared/ui/page'
import { SkeletonCards } from '@/shared/ui/skeleton'
import type { ActionStatus, ToolsetConfig, ToolsetModels, ToolsetProvider } from '../model/types'
import { ToolsetProviderRow } from './ToolsetProviderRow'

/** Provider matrix, API keys, install hooks, and the provider's model catalog. */
export function ToolsetConfiguration({
  config,
  models,
  selectedProvider,
  busyAction,
  pending,
  error,
  postSetupKey,
  postSetupStatus,
  onInspectProvider,
  onSelectProvider,
  onSelectModel,
  onSaveEnv,
  onPostSetup,
}: {
  config: ToolsetConfig | undefined
  models: ToolsetModels | undefined
  selectedProvider: string | null
  busyAction: string | null
  pending: boolean
  error: string | null
  postSetupKey: string | null
  postSetupStatus: ActionStatus | undefined
  onInspectProvider: (provider: string) => void
  onSelectProvider: (provider: ToolsetProvider, capability?: 'search' | 'extract') => void
  onSelectModel: (model: string) => void
  onSaveEnv: (provider: ToolsetProvider, values: Record<string, string>) => Promise<boolean>
  onPostSetup: (provider: ToolsetProvider, key: string) => void
}) {
  const pane = pending
    ? 'skeleton'
    : error
      ? 'error'
      : !config
        ? 'empty'
        : config.hasCategory
          ? 'ready'
          : 'native'
  const web = config?.name === 'web'

  return (
    <>
      <SectionCard title="провайдер" hint="кто исполняет тулы набора и на каких ключах">
        <SwapPane pane={pane}>
          {pane === 'skeleton' ? (
            <SkeletonCards count={3} height="h-28" label="читаем конфигурацию набора" />
          ) : pane === 'error' ? (
            <Notice>{error}</Notice>
          ) : pane === 'empty' ? (
            <EmptyHint>конфигурация недоступна</EmptyHint>
          ) : pane === 'native' ? (
            <EmptyHint>набору не нужен провайдер — hermes публикует его нативно</EmptyHint>
          ) : config ? (
            <>
              {web && (
                <div className="mb-3 grid grid-cols-2 gap-2">
                  <Backend label="поиск" value={config.activeSearchBackend} />
                  <Backend label="извлечение" value={config.activeExtractBackend} />
                </div>
              )}
              <div className="space-y-2">
                {config.providers.map((provider) => (
                  <ToolsetProviderRow
                    key={provider.name}
                    provider={provider}
                    selected={selectedProvider === provider.name}
                    web={web}
                    searchActive={
                      Boolean(provider.webBackend) &&
                      provider.webBackend === config.activeSearchBackend
                    }
                    extractActive={
                      Boolean(provider.webBackend) &&
                      provider.webBackend === config.activeExtractBackend
                    }
                    busyAction={busyAction}
                    postSetupKey={postSetupKey}
                    postSetupStatus={postSetupStatus}
                    onInspect={() => onInspectProvider(provider.name)}
                    onSelect={(capability) => onSelectProvider(provider, capability)}
                    onSaveEnv={(values) => onSaveEnv(provider, values)}
                    onPostSetup={(key) => onPostSetup(provider, key)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </SwapPane>
      </SectionCard>

      {selectedProvider && models?.hasModels && (
        <SectionCard title={`модель · ${models.provider ?? selectedProvider}`}>
          <ModelCatalog models={models} busy={busyAction === 'model'} onSelect={onSelectModel} />
        </SectionCard>
      )}
    </>
  )
}

function ModelCatalog({
  models,
  busy,
  onSelect,
}: {
  models: ToolsetModels
  busy: boolean
  onSelect: (model: string) => void
}) {
  return (
    <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
      {models.models.map((model) => {
        const active = model.id === models.current
        return (
          <button
            type="button"
            key={model.id}
            disabled={active || busy}
            data-selected={String(active)}
            className="card-interactive block w-full rounded-xl border border-line bg-ink/25 px-3 py-2 text-left"
            onClick={() => onSelect(model.id)}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 truncate text-xs text-paper">
                {model.display || model.id}
              </div>
              {model.speed && <span className="font-mono text-[9px] text-mute">{model.speed}</span>}
              {active && <Check aria-hidden="true" className="size-3.5 text-mercury" />}
            </div>
            <div className="mt-0.5 truncate font-mono text-[9px] text-mute">{model.id}</div>
            {(model.strengths || model.price) && (
              <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-mute">
                {[model.strengths, model.price].filter(Boolean).join(' · ')}
              </p>
            )}
          </button>
        )
      })}
      {!models.models.length && <EmptyHint>каталог моделей пуст</EmptyHint>}
    </div>
  )
}

function Backend({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl border border-line bg-ink/25 px-2.5 py-2">
      <div className="text-[8px] uppercase tracking-[0.14em] text-mute">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-paper">{value || 'автовыбор'}</div>
    </div>
  )
}
