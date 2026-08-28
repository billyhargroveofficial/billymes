import { useEffect, useRef, type RefObject } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * Scrolling level history for a live recording. Reads `levelsRef` inside its
 * own rAF loop and paints on a canvas, so no React state churns per frame;
 * bars inherit `currentColor`, which keeps the waveform theme-aware. When
 * `active` drops the loop stops and the last frame stays on screen.
 */
export function VoiceWaveform({
  levelsRef,
  active,
  className,
}: {
  levelsRef: RefObject<number[]>
  active: boolean
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!active) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let raf = 0
    const draw = () => {
      const ratio = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
        canvas.width = width * ratio
        canvas.height = height * ratio
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(canvas).color
      const bar = 2
      const gap = 2
      const capacity = Math.max(1, Math.floor(width / (bar + gap)))
      const levels = levelsRef.current.slice(-capacity)
      for (const [index, level] of levels.entries()) {
        const x = width - (levels.length - index) * (bar + gap)
        const barHeight = Math.max(2, Math.min(1, Math.sqrt(level) * 1.6) * height)
        context.fillRect(x, (height - barHeight) / 2, bar, barHeight)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [active, levelsRef])

  return <canvas ref={canvasRef} aria-hidden="true" className={cn('h-7 w-full', className)} />
}
