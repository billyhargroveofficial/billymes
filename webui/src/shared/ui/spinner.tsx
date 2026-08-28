import { cn } from '@/shared/lib/cn'

/**
 * CSS ring spinner. An SVG glyph under `animate-spin` orbits visibly when its
 * box lands on a subpixel offset; a bordered circle is drawn from its own
 * center, so the rotation cannot wobble. `will-change: transform` promotes it
 * to its own compositor layer — without it Chrome re-rasterises every frame
 * and rounds the origin to the device-pixel grid, which reads as an orbit at
 * fractional DPRs (2.5× here). Colored through `border-current`.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent will-change-transform motion-reduce:animate-none',
        className,
      )}
    />
  )
}
