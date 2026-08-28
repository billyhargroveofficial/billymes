import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * Shared page chrome. Every full-width route uses this so headings, scroll
 * behaviour, and gutters stay identical between features.
 */
export function PageShell({
  eyebrow,
  title,
  actions,
  children,
  className,
}: {
  eyebrow: string
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-y-auto p-4 md:p-6', className)}>
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.2em] text-mute">{eyebrow}</div>
          <h1 className="break-words font-display text-3xl italic text-mercury">{title}</h1>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

/** Titled panel used for the major blocks inside a page. */
export function SectionCard({
  title,
  icon,
  hint,
  actions,
  id,
  children,
  className,
}: {
  title: string
  /** Small glyph rendered beside the title, sized by the caller. */
  icon?: ReactNode
  hint?: string
  actions?: ReactNode
  id?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section
      {...(id ? { id } : {})}
      className={cn('scroll-mt-4 rounded-2xl border border-line bg-panel/40 p-4', className)}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-40 flex-1">
          <h2 className="flex items-center gap-1.5 break-words text-[10px] uppercase tracking-[0.18em] text-mute">
            {icon}
            {title}
          </h2>
          {hint && <p className="mt-1 break-words text-xs text-mute/80">{hint}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** Single headline number with its unit and caption. */
export function StatTile({
  value,
  label,
  caption,
  tone = 'default',
  className,
}: {
  value: ReactNode
  label: string
  caption?: string
  tone?: 'default' | 'accent' | 'ok' | 'ember'
  className?: string
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-mercury'
      : tone === 'ok'
        ? 'text-ok'
        : tone === 'ember'
          ? 'text-ember'
          : 'text-paper'
  return (
    <div className={cn('rounded-2xl border border-line bg-panel/40 px-4 py-3', className)}>
      <div className={cn('font-display text-2xl italic tabular-nums', toneClass)}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.16em] text-mute">{label}</div>
      {caption && <div className="mt-1 truncate text-[11px] text-mute/80">{caption}</div>}
    </div>
  )
}

/** Neutral placeholder for an empty result set. */
export function EmptyHint({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-mute',
        className,
      )}
    >
      {children}
    </p>
  )
}
