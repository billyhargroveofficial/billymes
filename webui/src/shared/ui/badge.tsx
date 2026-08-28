import { cn } from '@/shared/lib/cn'
import type { HTMLAttributes } from 'react'

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-mute',
        className,
      )}
      {...props}
    />
  )
}
