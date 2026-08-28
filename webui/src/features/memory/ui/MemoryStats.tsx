import { Brain, Gauge, Link2, Unplug, type LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/shared/lib/cn'
import { m } from '@/shared/ui/motion'
import { categoryHue } from '../model/category-color'
import { formatCount, LINK_FORMS } from '../model/graph-view'
import type { ClusterBar } from '../model/graph-view'
import type { LearningStats } from '../model/types'

const GROW = { scaleX: 0 }
const GROWN = { scaleX: 1 }

/**
 * Category breakdown as plain CSS bars. Deliberately not a force-directed
 * graph: the counts plus «связей на узел» say more and cost nothing in bundle
 * size. Each bar carries its category colour, which is the same one the hero
 * ribbon and the skill rows use.
 */
export function ConnectionsPanel({
  bars,
  stats,
  activeCategory,
  onCategory,
}: {
  bars: readonly ClusterBar[]
  stats: LearningStats
  activeCategory: string
  onCategory: (category: string) => void
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
      <ul className="flex flex-col gap-0.5">
        {bars.map((bar) => (
          <li key={bar.category}>
            <ClusterRow
              bar={bar}
              active={bar.category === activeCategory}
              dimmed={Boolean(activeCategory) && bar.category !== activeCategory}
              onCategory={onCategory}
            />
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-2 gap-2 self-start lg:grid-cols-1">
        <Fact
          icon={Link2}
          term="скилл ↔ скилл"
          value={formatCount(stats.relatedEdges, LINK_FORMS)}
        />
        <Fact
          icon={Brain}
          term="скилл ↔ память"
          value={formatCount(stats.memorySkillEdges, LINK_FORMS)}
        />
        <Fact icon={Gauge} term="плотность" value={`${stats.edgesPerNode} на узел`} />
        <Fact
          icon={Unplug}
          term="в стороне"
          value={`${stats.isolatedPct}%`}
          tone={stats.isolatedPct > 50 ? 'ember' : 'default'}
        />
      </dl>
    </div>
  )
}

function ClusterRow({
  bar,
  active,
  dimmed,
  onCategory,
}: {
  bar: ClusterBar
  active: boolean
  dimmed: boolean
  onCategory: (category: string) => void
}) {
  const isMemory = bar.category === 'memory'
  const style = { '--cat-h': categoryHue(bar.category) } as CSSProperties
  const body = (
    <>
      <span
        aria-hidden="true"
        style={style}
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          isMemory ? 'bg-mercury' : 'cat-swatch',
          dimmed && 'opacity-40',
        )}
      />
      <span className="w-36 shrink-0 truncate text-xs text-paper sm:w-44">
        {isMemory ? 'воспоминания' : bar.category}
      </span>
      <span style={style} className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
        <m.span
          initial={GROW}
          animate={GROWN}
          style={{ width: `${bar.percent}%`, transformOrigin: 'left' }}
          className={cn(
            'block h-full rounded-full transition-opacity duration-200',
            isMemory ? 'bg-mercury' : 'cat-swatch',
            dimmed && 'opacity-40',
          )}
        />
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-xs tabular-nums text-mute">
        {bar.count}
      </span>
    </>
  )

  if (isMemory) {
    return <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">{body}</div>
  }

  return (
    <button
      type="button"
      aria-pressed={active}
      data-selected={String(active)}
      onClick={() => onCategory(active ? '' : bar.category)}
      className="row-interactive flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left"
    >
      {body}
    </button>
  )
}

function Fact({
  icon: Icon,
  term,
  value,
  tone = 'default',
}: {
  icon: LucideIcon
  term: string
  value: string
  tone?: 'default' | 'ember'
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-line bg-raised/40 px-3 py-2">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', tone === 'ember' ? 'text-ember' : 'text-mute')}
      />
      <div className="min-w-0">
        <dt className="truncate text-[10px] uppercase tracking-[0.16em] text-mute">{term}</dt>
        <dd
          className={cn(
            'mt-0.5 truncate font-mono text-xs tabular-nums',
            tone === 'ember' ? 'text-ember' : 'text-paper',
          )}
        >
          {value}
        </dd>
      </div>
    </div>
  )
}
