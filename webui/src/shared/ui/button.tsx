import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-[background-color,border-color,color,filter,opacity,transform] duration-200 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-ink hover:brightness-105',
        mercury: 'bg-mercury text-accent-ink hover:brightness-105',
        ghost: 'bg-transparent text-paper/80 hover:bg-raised hover:text-paper',
        outline: 'card-interactive border border-line bg-transparent',
        ember: 'bg-ember text-accent-ink hover:brightness-110',
      },
      size: {
        default: 'h-10 px-4',
        sm: 'h-8 px-3 text-xs',
        icon: 'size-10',
        pill: 'h-9 px-3',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
