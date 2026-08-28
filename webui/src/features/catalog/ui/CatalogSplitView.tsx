import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Input } from '@/shared/ui/input'

export function CatalogSplitView({
  eyebrow,
  title,
  searchLabel,
  query,
  onQueryChange,
  actions,
  children,
  detail,
}: {
  eyebrow: string
  title: string
  searchLabel: string
  query: string
  onQueryChange: (value: string) => void
  /** Page-level controls that sit beside the search field. */
  actions?: ReactNode
  children: ReactNode
  detail: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-mute">{eyebrow}</div>
            <h1 className="font-display text-3xl italic text-mercury">{title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-72 sm:flex-none">
              <Search
                aria-hidden="true"
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute"
              />
              <Input
                type="search"
                name="catalog-search"
                autoComplete="off"
                aria-label={searchLabel}
                className="pl-9"
                placeholder={searchLabel}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>
            {actions}
          </div>
        </header>

        {children}
      </div>
      <aside className="hidden min-h-0 w-[clamp(22rem,40%,44rem)] shrink-0 overflow-y-auto border-l border-line px-6 py-6 lg:block xl:px-8 xl:py-8">
        {detail}
      </aside>
    </div>
  )
}
