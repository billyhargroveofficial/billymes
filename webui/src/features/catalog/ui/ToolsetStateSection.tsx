import { SectionCard } from '@/shared/ui/page'
import { Switch } from '@/shared/ui/switch'
import type { Toolset } from '../model/types'
import { Setting, StateChip } from './chips'

/**
 * Whether the набор is on, where its switch writes, and whether the global
 * deny list overrides it. Both switches here mutate the live agent config,
 * so each is disabled while its own save is in flight.
 */
export function ToolsetStateSection({
  toolset,
  profile,
  calls,
  denied,
  policyReady,
  togglePending,
  denyPending,
  onToggle,
  onDeny,
}: {
  toolset: Toolset
  profile: string
  calls: number
  denied: boolean
  /** the agent config has been read — the deny switch is meaningless without it */
  policyReady: boolean
  togglePending: boolean
  denyPending: boolean
  onToggle: (enabled: boolean) => void
  onDeny: (denied: boolean) => void
}) {
  const platform = toolset.platform || 'cli'
  const title = toolset.label || toolset.name
  return (
    <SectionCard
      title="состояние"
      hint={`переключатель пишет в platform_toolsets.${platform}`}
      actions={
        <Switch
          aria-label={`${toolset.enabled ? 'выключить' : 'включить'} набор ${title}`}
          checked={toolset.enabled}
          disabled={togglePending}
          onCheckedChange={onToggle}
        />
      }
    >
      <div className="flex flex-wrap gap-2">
        <StateChip ok={toolset.enabled} yes="включён" no="выключен" neutral />
        <StateChip ok={toolset.configured} yes="настроен" no="нужна настройка" />
        {denied && (
          <span className="inline-flex items-center rounded-full border border-ember/25 bg-ember/10 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-ember">
            запрещено политикой
          </span>
        )}
      </div>

      <dl className="mt-3 overflow-hidden rounded-xl border border-line bg-ink/25">
        <Setting label="профиль" value={profile} />
        <Setting label="площадка конфигурации" value={platform} mono />
        <Setting label="тулов в наборе" value={String(toolset.tools.length)} />
        <Setting label="вызовов · 90д" value={String(calls)} />
        <Setting
          label="доступность"
          value={toolset.available ? 'отдан площадке' : 'снят с площадки'}
        />
      </dl>
      <p className="mt-2 text-[11px] leading-4 text-mute/80">
        hermes считает доступность равной включению: отдельного признака «набор существует, но
        выключен» у гейтвея нет.
      </p>

      <div className="mt-3 flex items-start gap-3 rounded-xl border border-line bg-ink/25 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-paper">запретить набор глобально</div>
          <p className="mt-1 text-[11px] leading-4 text-mute">
            agent.disabled_toolsets вычитается последним — пока набор в списке, ни одна площадка и
            ни один allowlist задачи его не вернут
          </p>
        </div>
        <Switch
          aria-label={`${denied ? 'снять запрет' : 'запретить'} набор ${title} глобально`}
          checked={denied}
          disabled={!policyReady || denyPending}
          onCheckedChange={onDeny}
        />
      </div>
    </SectionCard>
  )
}
