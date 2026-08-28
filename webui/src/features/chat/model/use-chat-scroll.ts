import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react'

const EDGE = 96
const STORE = 'mes.chat-scroll:'

function loadPos(key: string) {
  try {
    const raw = sessionStorage.getItem(STORE + key)
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function savePos(key: string, top: number) {
  try {
    sessionStorage.setItem(STORE + key, String(Math.round(top)))
  } catch {
    /* ignore */
  }
}

function gap(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function farFromBottom(el: HTMLElement) {
  return gap(el) > Math.max(240, el.clientHeight * 0.4)
}

/**
 * Content can grow for two very different reasons: the stream appends below,
 * or the reader expands a tool/thinking node in place. Auto-following the
 * bottom is right for the first and hostile for the second, so the resize
 * observer pins only while a turn is live (or briefly after a session opens,
 * when lazy markdown and images are still settling the initial height).
 */
const SETTLE_GRACE_MS = 1_800

export function useChatScroll(
  sessionKey: string,
  dependency: unknown,
  ready: boolean,
  live: boolean,
) {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const pending = useRef<'bottom' | number | null>('bottom')
  const prevKey = useRef<string | null>(null)
  const animating = useRef(false)
  const animationTimer = useRef<number | null>(null)
  const settleUntil = useRef(0)
  const liveRef = useRef(live)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    liveRef.current = live
  }, [live])

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element
  }, [])

  useLayoutEffect(() => {
    if (prevKey.current === sessionKey) return
    const element = elementRef.current
    if (prevKey.current && element) savePos(prevKey.current, element.scrollTop)
    const saved = loadPos(sessionKey)
    pending.current = saved == null ? 'bottom' : saved
    prevKey.current = sessionKey
  }, [sessionKey])

  const pin = useCallback(
    (smooth = false) => {
      const el = elementRef.current
      if (!el) return
      follow.current = true
      setShowJump(false)
      const top = el.scrollHeight
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (smooth && !reduce) {
        animating.current = true
        el.scrollTo({ top, behavior: 'smooth' })
        if (animationTimer.current) window.clearTimeout(animationTimer.current)
        animationTimer.current = window.setTimeout(() => {
          animating.current = false
          follow.current = true
          setShowJump(false)
          savePos(sessionKey, el.scrollTop)
          animationTimer.current = null
        }, 450)
      } else {
        el.scrollTop = top
      }
      savePos(sessionKey, top)
    },
    [sessionKey],
  )

  useLayoutEffect(() => {
    const el = elementRef.current
    if (!el || !ready) return
    const plan = pending.current
    if (plan === 'bottom') {
      el.scrollTop = el.scrollHeight
      follow.current = true
      setShowJump(false)
      pending.current = null
      settleUntil.current = Date.now() + SETTLE_GRACE_MS
      savePos(sessionKey, el.scrollTop)
      return
    }
    if (typeof plan === 'number') {
      el.scrollTop = plan
      const atBottom = gap(el) < EDGE
      follow.current = atBottom
      setShowJump(farFromBottom(el))
      pending.current = null
      return
    }
    if (follow.current) {
      el.scrollTop = el.scrollHeight
      setShowJump(false)
    }
  }, [dependency, ready, sessionKey])

  useLayoutEffect(() => {
    const el = elementRef.current
    if (!el) return
    const inner = el.firstElementChild
    if (!inner) return
    const ro = new ResizeObserver(() => {
      if (!follow.current) return
      if (!liveRef.current && Date.now() > settleUntil.current) return
      el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    const onHide = () => savePos(sessionKey, el.scrollTop)
    window.addEventListener('pagehide', onHide)
    return () => {
      ro.disconnect()
      window.removeEventListener('pagehide', onHide)
      if (animationTimer.current) window.clearTimeout(animationTimer.current)
    }
  }, [ready, sessionKey])

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (animating.current) return
      const el = event.currentTarget
      const atBottom = gap(el) < EDGE
      follow.current = atBottom
      setShowJump(farFromBottom(el))
      savePos(sessionKey, el.scrollTop)
    },
    [sessionKey],
  )

  return { containerRef, showJump, onScroll, pin }
}
