import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

export function Sheet({
  open,
  onOpenChange,
  side = 'right',
  children,
  title,
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: 'right' | 'left' | 'bottom'
  title: string
  children: ReactNode
  className?: string
}) {
  const pos =
    side === 'bottom'
      ? 'inset-x-0 bottom-0 max-h-[82vh] rounded-t-3xl pb-[max(1rem,env(safe-area-inset-bottom))]'
      : side === 'left'
        ? 'inset-y-0 left-0 w-[min(92vw,22rem)] rounded-r-3xl pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))]'
        : 'inset-y-0 right-0 w-[min(92vw,24rem)] rounded-l-3xl pb-[max(1rem,env(safe-area-inset-bottom))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))]'
  const closePos =
    side === 'bottom'
      ? 'right-4 top-4'
      : side === 'right'
        ? 'right-[max(1rem,env(safe-area-inset-right))] top-[max(1rem,env(safe-area-inset-top))]'
        : 'right-4 top-[max(1rem,env(safe-area-inset-top))]'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          data-side={side}
          className={cn(
            'sheet-pane fixed z-50 flex flex-col overflow-hidden border border-line bg-panel p-4 shadow-desk outline-none',
            pos,
            className,
          )}
        >
          <Dialog.Title className="pr-10 font-display text-lg italic text-mercury">
            {title}
          </Dialog.Title>
          <Dialog.Description className="sr-only">Панель «{title}»</Dialog.Description>
          <Dialog.Close
            aria-label="закрыть панель"
            className={cn(
              'absolute grid size-8 place-items-center rounded-full text-mute transition-colors hover:bg-raised hover:text-paper',
              closePos,
            )}
          >
            <X aria-hidden="true" className="size-4" />
          </Dialog.Close>
          <div className="mt-3 min-h-0 flex-1 overscroll-contain overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
