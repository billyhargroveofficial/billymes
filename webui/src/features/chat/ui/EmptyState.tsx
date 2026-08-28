import { BrainCircuit, ListTodo, Newspaper, type LucideIcon } from 'lucide-react'
import { Rise, StaggerItem } from '@/shared/ui/motion'

const OPENERS: readonly { icon: LucideIcon; text: string }[] = [
  { icon: ListTodo, text: 'что сейчас в работе?' },
  { icon: Newspaper, text: 'собери сводку за сегодня' },
  { icon: BrainCircuit, text: 'покажи, что ты запомнил про меня' },
]

/**
 * The desk before the first message. It doubles as an entry point: the openers
 * fill the composer instead of leaving the user to stare at an empty column.
 */
export function EmptyState({
  profile,
  onOpener,
}: {
  profile: string
  onOpener: (text: string) => void
}) {
  return (
    <div className="relative mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 text-center">
      <div aria-hidden="true" className="aurora aurora-warm left-[8%] top-[16%] size-80" />
      <div aria-hidden="true" className="aurora aurora-cool bottom-[14%] right-[4%] size-96" />
      <Rise className="relative">
        <div className="text-[10px] uppercase tracking-[0.28em] text-mute">dispatch</div>
        <h2 className="mt-2 font-display text-4xl italic leading-none text-mercury md:text-5xl">
          стол открыт
        </h2>
        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-mute">
          Живой Hermes на локальном гейтвее. Пишешь — профиль{' '}
          <span className="font-mono text-[0.8rem] text-paper/80">{profile}</span> берёт тулы,
          скиллы и MCP как есть, без заглушек.
        </p>
      </Rise>
      <div className="relative mt-7 grid w-full gap-2 sm:grid-cols-3">
        {OPENERS.map((opener, index) => (
          <StaggerItem key={opener.text} index={index + 2} className="h-full">
            <button
              type="button"
              onClick={() => onOpener(opener.text)}
              className="card-interactive flex h-full w-full flex-col items-start gap-2.5 rounded-2xl border border-line bg-raised/50 px-3.5 py-3 text-left"
            >
              <opener.icon aria-hidden="true" className="size-4 text-mercury" />
              <span className="text-xs leading-5 text-paper/85">{opener.text}</span>
            </button>
          </StaggerItem>
        ))}
      </div>
    </div>
  )
}
