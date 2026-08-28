import { Check, Copy } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * Mono value plus a copy affordance. Used for device codes, verification URLs
 * and the shell commands that external providers must be disconnected with.
 */
export const CopyLine = memo(function CopyLine({
  value,
  label,
  href,
  className,
}: {
  value: string
  label: string
  href?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1600)
      },
      () => setCopied(false),
    )
  }, [value])

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xl border border-line bg-ink/50 px-3 py-2',
        className,
      )}
    >
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-xs text-signal underline-offset-2 hover:underline"
        >
          {value}
        </a>
      ) : (
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-paper">{value}</code>
      )}
      <button
        type="button"
        aria-label={copied ? `${label} скопировано` : `скопировать ${label}`}
        onClick={copy}
        className="grid size-7 shrink-0 place-items-center rounded-full text-mute transition-colors hover:bg-raised hover:text-paper"
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-ok" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </button>
    </div>
  )
})
