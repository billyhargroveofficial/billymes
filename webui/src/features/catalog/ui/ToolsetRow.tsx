import { memo } from 'react'
import { cn } from '@/shared/lib/cn'
import { Switch } from '@/shared/ui/switch'
import type { Toolset } from '../model/types'

/**
 * One row of the набор list. Presentational and memoised: the page passes
 * stable callbacks and primitives so re-ranking the list on every usage tick
 * does not re-render thirty rows.
 */
export const ToolsetRow = memo(function ToolsetRow({
  toolset,
  rank,
  calls,
  selected,
  denied,
  busy,
  onSelect,
  onToggle,
}: {
  toolset: Toolset
  rank: number
  calls: number
  selected: boolean
  /** listed in agent.disabled_toolsets — the switch cannot take effect */
  denied: boolean
  busy: boolean
  onSelect: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  const title = toolset.label || toolset.name
  return (
    <div
      data-selected={String(selected)}
      className="row-interactive flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
    >
      <span className="w-7 shrink-0 pl-1 font-mono text-[10px] text-mercury tabular-nums">
        #{rank}
      </span>
      <button
        type="button"
        aria-pressed={selected}
        className={cn('min-w-0 flex-1 text-left', !toolset.enabled && 'opacity-60')}
        onClick={() => onSelect(toolset.name)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          {denied && (
            <span className="shrink-0 rounded-full border border-ember/25 bg-ember/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-ember">
              запрещено
            </span>
          )}
          {!toolset.configured && (
            <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-mute">
              не настроен
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-mute">
          {toolset.platform_label || toolset.platform} · {toolset.tools.length} тулов
          {toolset.description ? ` · ${toolset.description}` : ''}
        </div>
      </button>
      <span className="shrink-0 font-mono text-xs tabular-nums text-paper">{calls}×</span>
      <Switch
        aria-label={`${toolset.enabled ? 'выключить' : 'включить'} набор ${title}`}
        checked={toolset.enabled}
        disabled={busy}
        onCheckedChange={(enabled) => onToggle(toolset.name, enabled)}
      />
    </div>
  )
})
