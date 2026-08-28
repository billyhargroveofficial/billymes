import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { cn } from '@/shared/lib/cn'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-sm text-paper placeholder:text-mute',
        className,
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'min-h-[52px] w-full resize-none overflow-y-auto rounded-2xl border border-line bg-ink/50 px-4 py-3 text-sm text-paper placeholder:text-mute [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0',
        className,
      )}
      {...props}
    />
  )
}
