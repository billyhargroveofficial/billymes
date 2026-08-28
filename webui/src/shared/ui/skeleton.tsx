import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * Unified loading placeholders. Every async surface uses these instead of a
 * bare "загружаем…" line so the layout keeps its shape while data arrives.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn('skeleton rounded-lg', className)} {...props} />
}

/** Screen-reader announcement wrapper for a group of skeleton blocks. */
export function SkeletonBlock({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

const TEXT_WIDTHS = ['100%', '92%', '78%', '86%', '64%']

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className="h-3"
          style={{ width: TEXT_WIDTHS[index % TEXT_WIDTHS.length] }}
        />
      ))}
    </div>
  )
}

/** Repeating list rows that mirror the catalog/list layout. */
export function SkeletonRows({
  rows = 6,
  label = 'загружаем список',
  className,
}: {
  rows?: number
  label?: string
  className?: string
}) {
  return (
    <SkeletonBlock
      label={label}
      className={cn('overflow-hidden rounded-2xl border border-line', className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line/60 px-3 py-3 last:border-0"
        >
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5" style={{ width: `${70 - (index % 4) * 12}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${52 - (index % 3) * 9}%` }} />
          </div>
          <Skeleton className="h-5 w-10 shrink-0 rounded-full" />
        </div>
      ))}
    </SkeletonBlock>
  )
}

/** Card grid placeholder for stat tiles and provider cards. */
export function SkeletonCards({
  count = 4,
  height = 'h-24',
  label = 'загружаем карточки',
  className,
}: {
  count?: number
  height?: string
  label?: string
  className?: string
}) {
  return (
    <SkeletonBlock label={label} className={cn('grid gap-3 sm:grid-cols-2', className)}>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className={cn('rounded-2xl', height)} />
      ))}
    </SkeletonBlock>
  )
}

/** Full-page placeholder used as the router's lazy-route fallback. */
export function SkeletonPage({ label = 'загружаем страницу' }: { label?: string }) {
  return (
    <SkeletonBlock label={label} className="min-h-0 flex-1 space-y-5 p-4 md:p-6">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-8 w-56" />
        </div>
        <Skeleton className="h-10 w-full max-w-72 rounded-xl" />
      </div>
      <SkeletonRows rows={7} label={label} />
    </SkeletonBlock>
  )
}
