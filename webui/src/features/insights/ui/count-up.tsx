import { memo, useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'

/**
 * Animated headline number: counts up from zero on mount and re-counts when
 * the target changes. Honours prefers-reduced-motion by jumping straight to
 * the value. State updates only happen inside animation frames, never
 * synchronously in the effect body.
 */
function useCountUp(target: number, duration = 850): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(0)
  const shownRef = useRef(0)

  useEffect(() => {
    const from = shownRef.current
    if (from === target) return
    const span = reduced ? 0 : duration
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const progress = span <= 0 ? 1 : Math.min(1, (now - start) / span)
      const eased = 1 - (1 - progress) ** 3
      const next = from + (target - from) * eased
      shownRef.current = next
      setValue(next)
      if (progress < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [duration, reduced, target])

  return reduced ? target : value
}

export const CountUp = memo(function CountUp({
  value,
  format,
  duration,
  className,
}: {
  value: number
  format: (value: number) => string
  duration?: number
  className?: string
}) {
  const shown = useCountUp(value, duration)
  return <span className={className}>{format(shown)}</span>
})
