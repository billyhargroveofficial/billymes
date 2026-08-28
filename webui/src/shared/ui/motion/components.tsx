import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from 'motion/react'
import type { ReactNode } from 'react'
import { EASE_OUT, EASE_SOFT } from './tokens'

/**
 * Motion policy for the whole desk.
 *
 * Surfaces use the lightweight `m` component with the `domAnimation` feature
 * set, which leaves the layout-projection and drag runtimes out of the bundle.
 * `reducedMotion="user"` makes every animation below honour the OS preference
 * without per-call guards.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={EASE_OUT}>
        {children}
      </MotionConfig>
    </LazyMotion>
  )
}

const RISE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
}

const FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

/** Content that fades and lifts into place — the default page/section entrance. */
export function Rise({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  return (
    <m.div {...RISE} transition={{ ...EASE_SOFT, delay }} {...(className ? { className } : {})}>
      {children}
    </m.div>
  )
}

/**
 * Cross-fades whatever is keyed by `pane` — used where one region swaps between
 * its skeleton, error, empty, and loaded states.
 */
export function SwapPane({
  pane,
  children,
  className,
}: {
  pane: string
  children: ReactNode
  className?: string
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div key={pane} {...FADE} transition={EASE_OUT} {...(className ? { className } : {})}>
        {children}
      </m.div>
    </AnimatePresence>
  )
}

/** List entrance with an index-derived stagger, capped so long lists stay snappy. */
export function StaggerItem({
  index,
  children,
  className,
}: {
  index: number
  children: ReactNode
  className?: string
}) {
  return (
    <m.div
      {...RISE}
      transition={{ ...EASE_OUT, delay: Math.min(index, 12) * 0.022 }}
      {...(className ? { className } : {})}
    >
      {children}
    </m.div>
  )
}
