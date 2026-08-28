import { Menu } from 'lucide-react'
import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { GatewaySheet, useGateway } from '@/features/gateway'
import { metaFor, useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { combinedErrorMessage } from '@/shared/lib/error-message'
import { EASE_OUT, m } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { Sheet } from '@/shared/ui/sheet'
import { DeskSidebar } from './DeskSidebar'

const FADE_IN = { opacity: 0 }
const SETTLED = { opacity: 1 }

export function AppShell() {
  const { profile, loadError: profileError } = useProfileScope()
  const { error: gatewayError } = useGateway()
  const loc = useLocation()
  const [gatewayOpen, setGatewayOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const shellError = combinedErrorMessage([profileError], [gatewayError])
  const meta = metaFor(profile)
  const openGateway = () => {
    setNavOpen(false)
    setGatewayOpen(true)
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-ink text-paper">
      <a
        href="#main-content"
        className="sr-only fixed left-3 top-3 z-[60] rounded-full bg-accent px-4 py-2 text-sm text-accent-ink focus:not-sr-only"
      >
        к содержимому
      </a>
      <div className="desk-grid pointer-events-none absolute inset-0 opacity-40" />

      <aside className="relative z-20 hidden h-full w-56 shrink-0 border-r border-line/80 bg-panel px-3 pb-3 pt-4 md:block">
        <DeskSidebar onGateway={openGateway} />
      </aside>

      {/* No mobile header: navigation hides behind one floating round button,
          so every vertical pixel stays with the page. On chat it sits top-left
          (the bottom belongs to the composer); on other pages it drops to the
          bottom corner so page headings stay unobstructed. */}
      <button
        type="button"
        aria-label="открыть меню"
        onClick={() => setNavOpen(true)}
        className={cn(
          'card-interactive fixed left-2 z-30 grid size-11 place-items-center rounded-full border border-line bg-panel/85 text-paper shadow-lift backdrop-blur-md md:hidden',
          loc.pathname === '/'
            ? 'top-[calc(env(safe-area-inset-top)+0.5rem)]'
            : 'bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]',
        )}
      >
        <Menu aria-hidden="true" className="size-5" />
      </button>

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
        {shellError && (
          <Notice className="shrink-0 border-b border-line/60 px-4 py-2 md:px-6">
            {shellError}
          </Notice>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] outline-none md:pb-0 md:pt-0"
        >
          <m.div
            key={loc.pathname}
            initial={FADE_IN}
            animate={SETTLED}
            transition={EASE_OUT}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <Outlet />
          </m.div>
        </main>
      </div>

      <GatewaySheet open={gatewayOpen} onOpenChange={setGatewayOpen} />

      <Sheet open={navOpen} onOpenChange={setNavOpen} side="left" title={meta.label}>
        <DeskSidebar heading={false} onNavigate={() => setNavOpen(false)} onGateway={openGateway} />
      </Sheet>
    </div>
  )
}
