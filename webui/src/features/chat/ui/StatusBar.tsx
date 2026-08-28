import { memo, useEffect, useState } from 'react'
import { ModelPicker, ReasoningPicker } from '@/features/model-selection'
import type { ConnectionState } from '@/features/gateway'
import { cn } from '@/shared/lib/cn'
import { fmtTokens } from '../model/format'
import { estimateContext } from '../model/session-utils'
import type { SessionRuntime } from '../model/types'

function fmtDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function ContextMeter({ runtime }: { runtime: SessionRuntime }) {
  const ctx = estimateContext(
    {
      ...(runtime.usage.input == null ? {} : { input_tokens: runtime.usage.input }),
      ...(runtime.usage.reasoning == null ? {} : { reasoning_tokens: runtime.usage.reasoning }),
      ...(runtime.usage.context_used == null ? {} : { context_used: runtime.usage.context_used }),
      context_max: runtime.usage.context_max || runtime.contextWindow,
    },
    runtime.contextWindow || runtime.usage.context_max || 272000,
  )
  if (!ctx.max) return null
  return (
    <span className="inline-flex items-center gap-1.5" title="контекст">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
        <span
          className="block h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${ctx.pct}%` }}
        />
      </span>
      <span className="font-mono">
        {fmtTokens(ctx.used)}/{fmtTokens(ctx.max)}
      </span>
    </span>
  )
}

const LINK_LABEL: Record<ConnectionState, string> = {
  idle: 'ожидание',
  connecting: 'подключение…',
  open: 'на связи',
  closed: 'связь потеряна',
  error: 'ошибка связи',
}

function LinkState({ state }: { state: ConnectionState }) {
  const ok = state === 'open'
  const pending = state === 'connecting' || state === 'idle'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5',
        ok ? 'text-mute' : pending ? 'text-mercury' : 'text-ember',
      )}
      title={`гейтвей: ${LINK_LABEL[state]}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          ok ? 'bg-ok/80' : pending ? 'pulse-soft bg-mercury' : 'bg-ember',
        )}
      />
      {!ok && <span className="hidden sm:inline">{LINK_LABEL[state]}</span>}
    </span>
  )
}

/**
 * Owns its own one-second clock. Keeping the tick here means the chat page and
 * the message list are not re-rendered once a second just to advance a timer.
 */
export const StatusBar = memo(function StatusBar({
  runtime,
  busy,
  connectionState,
  reasoningSupported,
  profile,
  lastTurnFallback,
  onModel,
  onReasoning,
}: {
  runtime: SessionRuntime
  busy: boolean
  connectionState: ConnectionState
  reasoningSupported: boolean
  profile: string
  /** Last-turn length recovered from history timestamps, for opened sessions. */
  lastTurnFallback: number | null
  onModel: (provider: string, model: string) => void
  onReasoning: (level: string) => void
}) {
  const now = useSecondsClock(busy)
  const liveTurn = busy && runtime.turnStartedAt ? now - runtime.turnStartedAt : null
  const lastTurn = runtime.lastTurnSeconds ?? lastTurnFallback

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-mute">
      <ModelPicker
        compact
        profile={profile}
        model={runtime.model}
        provider={runtime.provider}
        onPick={onModel}
      />
      {reasoningSupported && <ReasoningPicker value={runtime.reasoning} onPick={onReasoning} />}
      <LinkState state={connectionState} />
      {liveTurn != null ? (
        <span className="ml-auto font-mono tabular-nums text-mercury" title="ход идёт">
          ход {fmtDuration(liveTurn)}
        </span>
      ) : lastTurn != null ? (
        <span className="ml-auto font-mono tabular-nums" title="длительность прошлого хода">
          прошлый ход {fmtDuration(lastTurn)}
        </span>
      ) : null}
    </div>
  )
})

function useSecondsClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1_000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}
