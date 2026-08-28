import { Brain, Database, GraduationCap, Share2, type LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'
import { cn } from '@/shared/lib/cn'
import { m, Rise } from '@/shared/ui/motion'
import { categoryHue } from '../model/category-color'
import { CATEGORY_FORMS, formatCount } from '../model/graph-view'
import type { ClusterBar } from '../model/graph-view'
import type { LearningStats } from '../model/types'

const POP = { opacity: 0, y: 7 }
const SETTLED = { opacity: 1, y: 0 }
const LEGEND_LIMIT = 8

/** Cluster counts include the memory chunks; the ribbon is about skills only. */
const isSkillCluster = (bar: ClusterBar) => bar.category !== 'memory' && bar.count > 0

/**
 * The band that opens `/memory`: four headline numbers that double as section
 * navigation, and a ribbon showing which subjects the learned skills fall into.
 */
export function MemoryHero({
  stats,
  edges,
  bars,
  backend,
  activeCategory,
  onCategory,
}: {
  stats: LearningStats
  edges: number
  bars: readonly ClusterBar[]
  backend: string
  activeCategory: string
  onCategory: (category: string) => void
}) {
  const ribbon = bars.filter(isSkillCluster)
  return (
    <Rise>
      <section className="relative overflow-hidden rounded-3xl border border-line bg-panel/40">
        <div
          aria-hidden="true"
          className="aurora aurora-warm -right-16 -top-24 size-72 opacity-60"
        />
        <div
          aria-hidden="true"
          className="aurora aurora-cool -bottom-24 -left-24 size-64 opacity-40"
        />
        <div className="relative grid grid-cols-2 divide-line/50 divide-y xl:grid-cols-4 xl:divide-x xl:divide-y-0">
          <HeroStat
            icon={Brain}
            value={stats.memoryNodes}
            label="воспоминаний"
            caption="чанки MEMORY.md и профиля"
            tone="accent"
            target="sec-memory"
          />
          <HeroStat
            icon={GraduationCap}
            value={stats.learnedSkills}
            label="скиллов"
            caption={`${stats.used} пригодились · ${stats.agentCreated} от агента`}
            tone="paper"
            target="sec-skills"
          />
          <HeroStat
            icon={Share2}
            value={edges}
            label="связей"
            caption={`${stats.edgesPerNode} на узел · ${stats.isolatedPct}% в стороне`}
            tone={edges > 0 ? 'ok' : 'mute'}
            target="sec-links"
          />
          <HeroStat
            icon={Database}
            value={backend || 'встроенный'}
            label="бэкенд"
            caption={backend ? 'внешнее хранилище' : 'файлы MEMORY.md и USER.md'}
            tone={backend ? 'accent' : 'mute'}
            target="sec-backend"
          />
        </div>
        {ribbon.length > 0 && (
          <CategoryRibbon
            bars={ribbon}
            categories={stats.categories}
            active={activeCategory}
            onCategory={onCategory}
          />
        )}
      </section>
    </Rise>
  )
}

/**
 * One headline number. It doubles as navigation — the click scrolls to the
 * section it summarises — and the value remounts on change so the band reads
 * as live rather than as a static header.
 */
function HeroStat({
  icon: Icon,
  value,
  label,
  caption,
  tone,
  target,
}: {
  icon: LucideIcon
  value: number | string
  label: string
  caption: string
  tone: 'ok' | 'accent' | 'paper' | 'mute'
  target: string
}) {
  return (
    <button
      type="button"
      onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' })}
      className="group flex items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised/40 sm:px-5"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line/70 bg-raised/50 text-mercury transition-colors group-hover:border-accent/40">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <m.span
            key={String(value)}
            initial={POP}
            animate={SETTLED}
            className={cn(
              'max-w-full truncate font-display text-2xl italic leading-none',
              tone === 'ok'
                ? 'text-ok'
                : tone === 'accent'
                  ? 'text-mercury'
                  : tone === 'mute'
                    ? 'text-mute'
                    : 'text-paper',
            )}
          >
            {value}
          </m.span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-mute">
            {label}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-mute/80">{caption}</span>
      </span>
    </button>
  )
}

/**
 * Skill categories as one stacked ribbon plus a legend. The ribbon carries the
 * proportions, the legend carries the names and the filtering — keeping the
 * click target in one place instead of duplicating it across both.
 */
function CategoryRibbon({
  bars,
  categories,
  active,
  onCategory,
}: {
  bars: readonly ClusterBar[]
  categories: number
  active: string
  onCategory: (category: string) => void
}) {
  return (
    <div className="relative border-t border-line/60 px-4 py-3 sm:px-5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.18em] text-mute">чему научился</span>
        <span className="text-[11px] text-mute/70">{formatCount(categories, CATEGORY_FORMS)}</span>
      </div>

      <div aria-hidden="true" className="mt-2 flex h-1.5 w-full gap-px">
        {bars.map((bar) => (
          <span
            key={bar.category}
            style={{ '--cat-h': categoryHue(bar.category), flexGrow: bar.count } as CSSProperties}
            className={cn(
              'cat-swatch h-full min-w-[3px] rounded-full transition-opacity duration-200',
              active && active !== bar.category ? 'opacity-25' : 'opacity-90',
            )}
          />
        ))}
      </div>

      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {bars.slice(0, LEGEND_LIMIT).map((bar) => (
          <li key={bar.category}>
            <LegendChip
              bar={bar}
              active={active === bar.category}
              dimmed={Boolean(active) && active !== bar.category}
              onCategory={onCategory}
            />
          </li>
        ))}
        {bars.length > LEGEND_LIMIT && (
          <li
            className="self-center text-[11px] text-mute/70"
            title={bars
              .slice(LEGEND_LIMIT)
              .map((bar) => `${bar.category} — ${bar.count}`)
              .join('\n')}
          >
            +{bars.length - LEGEND_LIMIT}
          </li>
        )}
      </ul>
    </div>
  )
}

function LegendChip({
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
  const style = { '--cat-h': categoryHue(bar.category) } as CSSProperties
  return (
    <button
      type="button"
      aria-pressed={active}
      style={style}
      onClick={() => onCategory(active ? '' : bar.category)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-[opacity,color,background-color,border-color] duration-200',
        active
          ? 'cat-tint'
          : 'border-line/70 bg-raised/40 text-mute hover:border-line hover:text-paper',
        dimmed && 'opacity-55 hover:opacity-100',
      )}
    >
      <span aria-hidden="true" className="cat-swatch size-1.5 rounded-full" style={style} />
      <span className="max-w-40 truncate">{bar.category}</span>
      <span className="font-mono tabular-nums text-mute/70">{bar.count}</span>
    </button>
  )
}
