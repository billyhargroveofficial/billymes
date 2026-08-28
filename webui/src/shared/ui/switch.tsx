import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '@/shared/lib/cn'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-line bg-ink transition-colors data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-paper transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-ink" />
    </SwitchPrimitive.Root>
  )
}
