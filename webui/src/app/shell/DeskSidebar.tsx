import { Moon, Plug, Sun, SunMoon } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { APP_ROUTES, routeIsActive } from '@/app/router/route-registry'
import { hostFromOrigin, useGateway } from '@/features/gateway'
import { metaFor, useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { useTheme } from '@/shared/theme'

// Lazy: a static import would drag the whole providers feature into the
// entry chunk that the route registry deliberately code-splits away.
const OauthUsageStrip = lazy(async () => {
  const feature = await import('@/features/providers')
  return { default: feature.OauthUsageStrip }
})

const THEME_LABEL = {
  system: 'тема: системная',
  light: 'тема: светлая',
  dark: 'тема: тёмная',
} as const

/**
 * The one sidebar the whole desk navigates from. On wide screens it stands
 * as the permanent left column; on phones the same component rides inside a
 * left drawer, which is why navigation reports through `onNavigate` so the
 * drawer can close itself.
 */
export function DeskSidebar({
  heading = true,
  onNavigate,
  onGateway,
}: {
  heading?: boolean
  onNavigate?: () => void
  onGateway: () => void
}) {
  const { profile, status } = useProfileScope()
  const { settings, runtime } = useGateway()
  const { mode, toggle } = useTheme()
  const { pathname } = useLocation()
  const meta = metaFor(profile)
  const live = Boolean(status?.gateway_running)
  const remote = settings.mode === 'remote'

  return (
    <div className="flex h-full min-h-0 flex-col">
      {heading && (
        <div className="shrink-0 px-1">
          <div className="text-[10px] uppercase tracking-[0.22em] text-mute">{meta.kicker}</div>
          <div className="truncate font-display text-lg italic leading-tight text-paper">
            {meta.label}
          </div>
        </div>
      )}

      <nav
        aria-label="основная навигация"
        className="mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto no-scrollbar"
      >
        {APP_ROUTES.map((item) => {
          // Resolved here as a plain string: a function className would be
          // flattened to source text by any Slot-style parent.
          const active = routeIsActive(item, pathname)
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              onPointerEnter={item.preload}
              onFocus={item.preload}
              onClick={onNavigate}
              className={cn(
                'flex shrink-0 items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] text-paper/60 transition-colors duration-200 hover:bg-raised hover:text-paper md:gap-2.5 md:py-2 md:text-[13px]',
                active &&
                  'bg-accent text-accent-ink shadow-lift hover:bg-accent hover:text-accent-ink',
              )}
            >
              <item.icon aria-hidden="true" className="size-[18px] shrink-0 md:size-4" />
              {item.label}
            </NavLink>
          )
        })}
      </nav>

      <div className="mt-3 shrink-0 space-y-2 border-t border-line/60 pt-3">
        <Suspense fallback={null}>
          <OauthUsageStrip profile={profile} className="flex flex-wrap" />
        </Suspense>
        <button
          type="button"
          aria-label="настройки гейтвея"
          onClick={onGateway}
          className="card-interactive flex w-full items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2.5 text-left text-[13px] text-mute md:py-2 md:text-[11px]"
        >
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0 rounded-full', live ? 'bg-ok' : 'bg-ember')}
          />
          <Plug
            aria-hidden="true"
            className={cn('size-4 shrink-0 md:size-3.5', remote ? 'text-mercury' : 'text-mute')}
          />
          <span className="min-w-0 truncate">
            {status?.version ?? '…'} ·{' '}
            {remote
              ? runtime?.host || hostFromOrigin(settings.origin)
              : (status?.gateway_state ?? 'offline')}
          </span>
        </button>
        <button
          type="button"
          onClick={toggle}
          title={THEME_LABEL[mode]}
          aria-label={`${THEME_LABEL[mode]} — переключить`}
          className="card-interactive flex w-full items-center gap-2 rounded-xl border border-line bg-raised px-3 py-2.5 text-left text-[13px] text-mute md:py-2 md:text-[11px]"
        >
          {mode === 'system' ? (
            <SunMoon aria-hidden="true" className="size-4 shrink-0 text-paper md:size-3.5" />
          ) : mode === 'light' ? (
            <Sun aria-hidden="true" className="size-4 shrink-0 text-paper md:size-3.5" />
          ) : (
            <Moon aria-hidden="true" className="size-4 shrink-0 text-paper md:size-3.5" />
          )}
          {THEME_LABEL[mode]}
        </button>
      </div>
    </div>
  )
}
