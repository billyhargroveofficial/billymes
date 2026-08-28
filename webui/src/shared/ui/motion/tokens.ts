export { m } from 'motion/react'

/** Shared timing so unrelated surfaces still feel like one product. */
export const EASE_OUT = { duration: 0.22, ease: [0.22, 0.61, 0.36, 1] } as const
export const EASE_SOFT = { duration: 0.32, ease: [0.16, 1, 0.3, 1] } as const
