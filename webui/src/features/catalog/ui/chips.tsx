import { Check, Minus, X } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

/** Binary state as a warm/ember pill — enabled, available, configured, … */
export function StateChip({
  ok,
  yes,
  no,
  neutral = false,
}: {
  ok: boolean
  yes: string
  no: string
  /** render the "off" side as plain rather than as a problem */
  neutral?: boolean
}) {
  const Icon = ok ? Check : neutral ? Minus : X
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.1em]',
        ok
          ? 'border-ok/25 bg-ok/10 text-ok'
          : neutral
            ? 'border-line bg-raised/60 text-mute'
            : 'border-ember/25 bg-ember/10 text-ember',
      )}
    >
      <Icon aria-hidden="true" className="size-3" /> {ok ? yes : no}
    </span>
  )
}

const STATUS_COPY: Record<string, string> = {
  ready: 'готов',
  needs_keys: 'нужны ключи',
  needs_auth: 'нужна авторизация',
  needs_setup: 'нужна установка',
  unavailable: 'недоступен',
  ok: 'ок',
  warn: 'внимание',
  error: 'ошибка',
}

/** Provider / backend / probe status, translated where Hermes has a known code. */
export function StatusPill({ status, className }: { status: string; className?: string }) {
  const good = status === 'ready' || status === 'ok'
  const bad = status === 'error' || status === 'unavailable'
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.1em]',
        good
          ? 'border-ok/25 bg-ok/10 text-ok'
          : bad
            ? 'border-ember/25 bg-ember/10 text-ember'
            : 'border-line bg-raised/60 text-mute',
        className,
      )}
    >
      {STATUS_COPY[status] ?? status.replaceAll('_', ' ')}
    </span>
  )
}

/** One `label → value` line inside a settings list. */
export function Setting({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-4 border-b border-line/60 px-3 py-2 last:border-0">
      <dt className="shrink-0 text-[11px] text-mute">{label}</dt>
      <dd
        className={cn(
          'ml-auto min-w-0 truncate text-right text-xs text-paper',
          mono && 'font-mono',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
