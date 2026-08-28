import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export function Notice({
  children,
  tone = 'error',
  className,
}: {
  children: ReactNode
  tone?: 'error' | 'success'
  className?: string
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={cn('text-xs', tone === 'error' ? 'text-ember' : 'text-ok', className)}
    >
      {children}
    </p>
  )
}
