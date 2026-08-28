import { Bot, Pin } from 'lucide-react'
import { memo } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '@/shared/lib/cn'
import { m, StaggerItem } from '@/shared/ui/motion'
import { categoryHue } from '../model/category-color'
import { relativeTime } from '../model/graph-view'
import type { LearningNode } from '../model/types'

const GROW = { scaleX: 0 }
const GROWN = { scaleX: 1 }

/**
 * Learned skills, most-used first. The list is sorted by use count, so the
 * usage bars form a descending waterfall — the ranking is visible without
 * printing a position number next to every row.
 */
export function LearnedSkillList({
  nodes,
  now,
  selectedId,
  onSelect,
}: {
  nodes: readonly LearningNode[]
  now: number
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const peak = nodes.reduce((most, node) => Math.max(most, node.useCount), 0)
  return (
    <ul className="overflow-hidden rounded-2xl border border-line">
      {nodes.map((node, index) => (
        <li key={node.id} className="border-b border-line/60 last:border-0">
          <StaggerItem index={index}>
            <SkillRow
              node={node}
              now={now}
              peak={peak}
              selected={node.id === selectedId}
              onSelect={onSelect}
            />
          </StaggerItem>
        </li>
      ))}
    </ul>
  )
}

const SkillRow = memo(function SkillRow({
  node,
  now,
  peak,
  selected,
  onSelect,
}: {
  node: LearningNode
  now: number
  peak: number
  selected: boolean
  onSelect: (id: string) => void
}) {
  const style = { '--cat-h': categoryHue(node.category) } as CSSProperties
  const share = peak > 0 ? Math.max(4, Math.round((node.useCount / peak) * 100)) : 0

  return (
    <button
      type="button"
      aria-pressed={selected}
      data-selected={String(selected)}
      onClick={() => onSelect(node.id)}
      className="row-interactive flex w-full items-center gap-3 px-3 py-2.5 text-left"
    >
      <span
        aria-hidden="true"
        style={style}
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-xl border font-mono text-xs uppercase',
          node.category ? 'cat-tint' : 'border-line bg-raised/50 text-mute',
        )}
      >
        {node.label.slice(0, 1)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-mono text-xs text-paper">{node.label}</span>
          {node.pinned && <Pin aria-label="закреплено" className="size-3 shrink-0 text-mercury" />}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-mute">
          {node.category && (
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="cat-swatch size-1.5 rounded-full" style={style} />
              {node.category}
            </span>
          )}
          <span className="text-mute/80">{relativeTime(node.timestamp, now)}</span>
          {node.createdBy === 'agent' && (
            <span className="inline-flex items-center gap-1 text-mute/80">
              <Bot aria-hidden="true" className="size-3" />
              агент
            </span>
          )}
        </span>
      </span>

      <span aria-hidden="true" className="hidden w-20 shrink-0 sm:block">
        <span className="block h-1 overflow-hidden rounded-full bg-raised">
          <m.span
            initial={GROW}
            animate={GROWN}
            style={{ width: `${share}%`, transformOrigin: 'left' }}
            className={cn(
              'block h-full rounded-full',
              node.useCount > 0 ? 'bg-accent/80' : 'bg-line',
            )}
          />
        </span>
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-mercury">
        {node.useCount}×
      </span>
    </button>
  )
})
