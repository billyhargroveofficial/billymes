import { cn } from '@/shared/lib/cn'

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  /** Optional accessible name when the visible label is an abbreviation. */
  title?: string
}

/**
 * Single-choice control for range pickers and view switches. It is a real
 * radio group so arrow keys and screen readers behave, and it shares one
 * appearance across every feature that needs a small set of exclusive options.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-line bg-raised/60 p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            {...(option.title ? { title: option.title } : {})}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full px-3 py-1 text-xs transition-colors duration-200',
              active ? 'bg-accent text-accent-ink' : 'text-mute hover:bg-panel hover:text-paper',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
