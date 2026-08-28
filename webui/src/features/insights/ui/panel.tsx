import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

/** Untitled block: a small mute heading and the list or line beneath it. */
export function Block({
  title,
  actions,
  children,
  className,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0', className)}>
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[10px] uppercase tracking-[0.18em] text-mute">{title}</h2>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
