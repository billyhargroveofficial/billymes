import { Activity } from 'lucide-react'
import { lazy, memo, Suspense } from 'react'
import { cn } from '@/shared/lib/cn'
import { m } from '@/shared/ui/motion'
import { ContextMeter } from './StatusBar'
import { TodoPanel } from './activity-blocks'
import { fmtTokens } from '../model/format'
import type { ChatMessage, SessionInfo, SessionRuntime } from '../model/types'

const SessionList = lazy(async () => {
  const feature = await import('./SessionList')
  return { default: feature.SessionList }
})

const POP = { opacity: 0, y: 7 }
const POP_SETTLED = { opacity: 1, y: 0 }

/** Memoised: it reads settled counters, not the streaming buffer. */
export const Inspector = memo(function Inspector({
  todos,
  tools,
  runningTools,
  toolCounts,
  subagents,
  sessions,
  activeId,
  playingId,
  profile,
  onOpen,
  platforms,
  runtime,
}: {
  todos: ChatMessage['todos']
  tools: number
  runningTools: number
  toolCounts: [string, number][]
  subagents: number
  sessions: SessionInfo[]
  activeId: string | null
  playingId: string | null
  profile: string
  onOpen: (id: string) => void
  platforms?: Record<string, { state: string }>
  runtime: SessionRuntime
}) {
  const quiet = !tools && !todos.length && !subagents
  const maxToolCount = toolCounts[0]?.[1] || 1

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex h-5 items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-mute">
        <Activity
          aria-hidden="true"
          className={cn('size-3', runningTools > 0 && 'pulse-soft text-ember')}
        />
        ход работы
        {runningTools > 0 && (
          <span className="ml-auto font-mono normal-case tracking-normal text-ember">
            {runningTools} live
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat n={tools} label="тулы" />
        <Stat n={todos.length} label="туду" />
        <Stat n={subagents} label="дети" />
      </div>
      {quiet && (
        <p className="rounded-2xl border border-dashed border-line px-3 py-4 text-center text-xs leading-5 text-mute">
          пока тихо — здесь появятся тулы, туду и подагенты
        </p>
      )}
      {toolCounts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line">
          {toolCounts.slice(0, 12).map(([name, count]) => (
            <div key={name} className="border-b border-line/50 px-2.5 py-1.5 last:border-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{name}</span>
                <span className="font-mono text-[11px] tabular-nums text-mute">{count}×</span>
              </div>
              <span
                aria-hidden="true"
                className="mt-1 block h-0.5 rounded-full bg-accent/30 transition-[width] duration-500"
                style={{ width: `${Math.round((count / maxToolCount) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      )}
      <div className="rounded-2xl border border-line bg-raised/70 px-3 py-2.5 font-mono text-[11px] text-mute">
        <div className="mb-0.5 text-[9px] uppercase tracking-[0.18em] text-mute/70">модель</div>
        <div className="truncate text-paper/85">{runtime.model || '—'}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span title="ввод / вывод">
            ↑{fmtTokens(runtime.usage.input)} ↓{fmtTokens(runtime.usage.output)}
          </span>
          <ContextMeter runtime={runtime} />
        </div>
      </div>
      <TodoPanel todos={todos} />
      {Object.keys(platforms ?? {}).length > 0 && (
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-mute">шлюзы</div>
          <ul className="space-y-1.5 text-xs text-mute">
            {Object.entries(platforms ?? {}).map(([name, row]) => (
              <li key={name} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    row.state === 'connected' ? 'bg-ok' : 'bg-ember',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <span className={row.state === 'connected' ? 'text-ok/80' : 'text-ember'}>
                  {row.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="xl:hidden">
        <Suspense fallback={null}>
          <SessionList
            sessions={sessions}
            activeId={activeId}
            playingId={playingId}
            profile={profile}
            onOpen={onOpen}
          />
        </Suspense>
      </div>
    </div>
  )
})

/** The number remounts on change, popping in — a cheap live-counter effect. */
function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-raised/70 px-3 py-2">
      <m.div
        key={n}
        initial={POP}
        animate={POP_SETTLED}
        className="font-display text-2xl italic text-mercury"
      >
        {n}
      </m.div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-mute">{label}</div>
    </div>
  )
}
