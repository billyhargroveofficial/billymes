import { Notice } from '@/shared/ui/notice'
import { StatTile } from '@/shared/ui/page'
import { toolsetUsage } from '../model/toolset-view'
import type {
  ActionStatus,
  MessagingPlatform,
  Toolset,
  ToolPolicyConfig,
  ToolsetConfig,
  ToolsetModels,
  ToolsetProvider,
  ToolUsage,
} from '../model/types'
import { ToolsetConfiguration } from './ToolsetConfiguration'
import { ToolsetPlatformsSection } from './ToolsetPlatformsSection'
import { ToolsetStateSection } from './ToolsetStateSection'
import { ToolsetToolsSection } from './ToolsetToolsSection'

/** Everything the desk can configure about one набор, as stacked sections. */
export function ToolsetDetail({
  toolset,
  toolsets,
  profile,
  usage,
  counts,
  policy,
  policyPending,
  policyError,
  platforms,
  platformsPending,
  platformsError,
  config,
  models,
  configPending,
  configError,
  selectedProvider,
  busy,
  actionError,
  postSetupKey,
  postSetupStatus,
  onToggle,
  onDeny,
  onAssign,
  onInspectProvider,
  onSelectProvider,
  onSelectModel,
  onSaveEnv,
  onPostSetup,
}: {
  toolset: Toolset
  toolsets: readonly Toolset[]
  profile: string
  usage: ReadonlyMap<string, ToolUsage>
  counts: ReadonlyMap<string, number>
  policy: ToolPolicyConfig | undefined
  policyPending: boolean
  policyError: string | null
  platforms: MessagingPlatform[] | undefined
  platformsPending: boolean
  platformsError: string | null
  config: ToolsetConfig | undefined
  models: ToolsetModels | undefined
  configPending: boolean
  configError: string | null
  selectedProvider: string | null
  busy: string | null
  actionError: string | null
  postSetupKey: string | null
  postSetupStatus: ActionStatus | undefined
  onToggle: (enabled: boolean) => void
  onDeny: (denied: boolean) => void
  onAssign: (platform: string, assign: boolean) => void
  onInspectProvider: (provider: string) => void
  onSelectProvider: (provider: ToolsetProvider, capability?: 'search' | 'extract') => void
  onSelectModel: (model: string) => void
  onSaveEnv: (provider: ToolsetProvider, values: Record<string, string>) => Promise<boolean>
  onPostSetup: (provider: ToolsetProvider, key: string) => void
}) {
  const calls = toolsetUsage(toolset, counts)
  const adapter = toolset.platform_label || toolset.platform || '—'
  const denied = policy?.disabledToolsets.includes(toolset.name) ?? false
  const servedBy = policy
    ? Object.entries(policy.platformToolsets).filter(([, keys]) => keys.includes(toolset.name))
        .length
    : 0

  return (
    <article className="min-w-0 space-y-4">
      <header className="border-b border-line pb-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-mute">TOOLSET · {adapter}</div>
        <h2 className="mt-1 font-display text-3xl italic leading-none text-mercury">
          {toolset.label || toolset.name}
        </h2>
        <div className="mt-1 font-mono text-[11px] text-mute">{toolset.name}</div>
        {toolset.description && (
          <p className="mt-3 whitespace-pre-line text-sm leading-6 text-mute">
            {toolset.description}
          </p>
        )}
        <div className="mt-4 grid grid-cols-3 gap-2">
          <StatTile value={toolset.tools.length} label="тулов" tone="accent" />
          <StatTile value={calls} label="вызовов · 90д" tone="accent" />
          <StatTile value={servedBy} label="площадок" tone="accent" />
        </div>
      </header>

      {actionError && <Notice>{actionError}</Notice>}

      <ToolsetStateSection
        toolset={toolset}
        profile={profile}
        calls={calls}
        denied={denied}
        policyReady={Boolean(policy)}
        togglePending={busy === `toggle:${toolset.name}`}
        denyPending={busy === 'deny'}
        onToggle={onToggle}
        onDeny={onDeny}
      />

      <ToolsetPlatformsSection
        toolset={toolset}
        toolsets={toolsets}
        config={policy}
        platforms={platforms}
        pending={policyPending || platformsPending}
        error={policyError ?? platformsError}
        busy={busy}
        onAssign={onAssign}
      />

      <ToolsetToolsSection toolset={toolset} usage={usage} />

      <ToolsetConfiguration
        config={config}
        models={models}
        selectedProvider={selectedProvider}
        busyAction={busy}
        pending={configPending}
        error={configError}
        postSetupKey={postSetupKey}
        postSetupStatus={postSetupStatus}
        onInspectProvider={onInspectProvider}
        onSelectProvider={onSelectProvider}
        onSelectModel={onSelectModel}
        onSaveEnv={onSaveEnv}
        onPostSetup={onPostSetup}
      />
    </article>
  )
}
