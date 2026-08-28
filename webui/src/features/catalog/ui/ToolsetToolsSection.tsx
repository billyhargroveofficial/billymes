import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Input } from '@/shared/ui/input'
import { SwapPane } from '@/shared/ui/motion'
import { EmptyHint, SectionCard } from '@/shared/ui/page'
import { filterToolRows, summariseToolRows, toolRows } from '../model/tool-usage'
import { automationTools } from '../model/toolset-view'
import type { Toolset, ToolUsage } from '../model/types'

/**
 * The individual tools a набор publishes, with their real call counts.
 *
 * Hermes has no per-tool switch — no endpoint and no config key turns one tool
 * inside a набор on or off — so this list is deliberately read-only: it shows
 * exactly what the набор's switch governs instead of faking a control.
 */
export function ToolsetToolsSection({
  toolset,
  usage,
}: {
  toolset: Toolset
  usage: ReadonlyMap<string, ToolUsage>
}) {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => toolRows(toolset.tools, usage), [toolset.tools, usage])
  const automation = useMemo(() => new Set(automationTools(toolset)), [toolset])
  const visible = useMemo(() => filterToolRows(rows, query), [query, rows])
  const summary = useMemo(() => summariseToolRows(rows), [rows])
  const peak = rows[0]?.count ?? 0
  const pane = !rows.length ? 'empty' : visible.length ? 'ready' : 'nomatch'

  return (
    <SectionCard
      title="тулы"
      hint="единица управления — набор целиком; отдельный тул hermes не выключает"
      {...(rows.length > 6
        ? {
            actions: (
              <div className="relative w-40">
                <Search
                  aria-hidden="true"
                  className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-mute"
                />
                <Input
                  type="search"
                  autoComplete="off"
                  aria-label="найти тул в наборе"
                  className="h-8 pl-8 text-xs"
                  placeholder="найти тул"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ),
          }
        : {})}
    >
      <div className="mb-2 text-[11px] text-mute tabular-nums">
        {summary.tools} тулов · {summary.calls} вызовов · {summary.share.toFixed(1)}% всех вызовов
        за 90 дней
      </div>
      <SwapPane pane={pane}>
        {pane === 'empty' ? (
          <EmptyHint>набор работает на уровне площадки и не публикует отдельные вызовы</EmptyHint>
        ) : pane === 'nomatch' ? (
          <EmptyHint>по запросу тулов нет</EmptyHint>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            {visible.map((row) => (
              <div
                key={row.tool}
                className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs text-paper">{row.tool}</span>
                    {automation.has(row.tool) && (
                      <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-mute">
                        оркестрация
                      </span>
                    )}
                  </div>
                  <div
                    aria-hidden="true"
                    className="mt-1 h-1 overflow-hidden rounded-full bg-raised/70"
                  >
                    <div
                      className="h-full rounded-full bg-accent/70"
                      style={{ width: `${peak ? Math.max(2, (row.count / peak) * 100) : 0}%` }}
                    />
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-paper">
                  {row.count}×
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-mute">
                  {row.percentage.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </SwapPane>
    </SectionCard>
  )
}
