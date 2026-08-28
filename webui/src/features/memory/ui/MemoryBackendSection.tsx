import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Database, Flame } from 'lucide-react'
import { useCallback, useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, SectionCard } from '@/shared/ui/page'
import { Segmented } from '@/shared/ui/segmented'
import { SkeletonCards } from '@/shared/ui/skeleton'
import { memoryApi } from '../api/memory-api'
import { formatBytes, plural } from '../model/graph-view'
import type { BuiltinMemoryFile, ResetTarget } from '../model/types'
import { ProviderCard } from './ProviderCard'

const CONFIRM_WORD = 'стереть'

const READY_FORMS = ['готов', 'готовы', 'готовы'] as const

const RESET_OPTIONS: readonly { value: ResetTarget; label: string }[] = [
  { value: 'memory', label: 'память' },
  { value: 'user', label: 'о пользователе' },
  { value: 'all', label: 'всё' },
]

const RESET_FILES: Record<ResetTarget, readonly string[]> = {
  memory: ['memory'],
  user: ['user'],
  all: ['memory', 'user'],
}

const FILE_LABEL: Record<string, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
}

/** Which backend stores the memory, and the destructive reset below it. */
export function MemoryBackendSection({
  profile,
  expandedProvider,
  onExpandProvider,
}: {
  profile: string
  expandedProvider: string
  onExpandProvider: (name: string) => void
}) {
  const status = useQuery({ queryKey: ['memory', 'status'], queryFn: () => memoryApi.status() })
  const providers = status.data?.providers ?? []
  const active = status.data?.active ?? ''
  const ready = providers.filter((provider) => provider.status === 'ready').length
  const pane = status.isPending
    ? 'skeleton'
    : status.error
      ? 'error'
      : providers.length
        ? 'ready'
        : 'empty'

  return (
    <SectionCard
      id="sec-backend"
      icon={<Database aria-hidden="true" className="size-3" />}
      title="бэкенд памяти"
      hint={
        active
          ? `активен «${active}» — общий для всех профилей`
          : 'бэкенд не выбран: работают встроенные файлы памяти'
      }
      actions={
        providers.length ? (
          <span className="text-[11px] text-mute/80">
            {ready} из {providers.length} {plural(ready, READY_FORMS)}
          </span>
        ) : null
      }
    >
      <SwapPane pane={pane}>
        {pane === 'skeleton' ? (
          <SkeletonCards count={6} height="h-40" label="читаем бэкенды памяти" />
        ) : pane === 'error' ? (
          <Notice>{errorMessage(status.error, 'не удалось загрузить бэкенды памяти')}</Notice>
        ) : pane === 'empty' ? (
          <EmptyHint>бэкендов нет</EmptyHint>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.name}
                provider={provider}
                active={provider.name === active}
                profile={profile}
                expanded={provider.name === expandedProvider}
                onExpand={onExpandProvider}
              />
            ))}
          </div>
        )}
      </SwapPane>

      <ResetPanel files={status.data?.builtinFiles ?? []} />
    </SectionCard>
  )
}

/**
 * The one irreversible control on the page, so it says exactly which files it
 * will erase and how big they are, and it stays disarmed until the word is
 * typed out in full.
 */
function ResetPanel({ files }: { files: readonly BuiltinMemoryFile[] }) {
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<ResetTarget>('memory')
  const [typed, setTyped] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const reset = useMutation({
    mutationFn: () => memoryApi.reset(target),
    onSuccess: async () => {
      setTyped('')
      setFailure(null)
      setDone(`стёрто: ${describe(target, files)}`)
      await queryClient.invalidateQueries({ queryKey: ['memory'] })
    },
    onError: (error) => setFailure(errorMessage(error, 'не удалось стереть память')),
  })

  const changeTarget = useCallback((value: ResetTarget) => {
    setTarget(value)
    setTyped('')
    setDone(null)
  }, [])

  const armed = typed.trim().toLowerCase() === CONFIRM_WORD

  return (
    <div className="mt-4 rounded-2xl border border-ember/25 bg-ember/[0.045] p-4">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-xl border border-ember/35 bg-ember/10 text-ember"
        >
          <Flame className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-[10px] uppercase tracking-[0.18em] text-ember">сбросить память</h3>
          <p className="mt-1 max-w-prose text-xs leading-5 text-mute">
            сотрёт {describe(target, files)}. восстановить нельзя — сначала выбери, что именно,
            потом напиши «{CONFIRM_WORD}».
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="что стереть"
          value={target}
          options={RESET_OPTIONS}
          onChange={changeTarget}
        />
        <div className="relative">
          <Input
            aria-label={`напиши «${CONFIRM_WORD}» чтобы подтвердить`}
            autoComplete="off"
            className={cn(
              'h-9 w-44 pr-8 transition-colors duration-200',
              armed && 'border-ember/60 text-ember',
            )}
            placeholder={CONFIRM_WORD}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          {armed && (
            <Check
              aria-hidden="true"
              className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ember"
            />
          )}
        </div>
        <Button
          size="sm"
          variant="ember"
          disabled={!armed || reset.isPending}
          onClick={() => reset.mutate()}
        >
          {reset.isPending ? 'стираем…' : 'стереть'}
        </Button>
      </div>

      {failure && <Notice className="mt-2">{failure}</Notice>}
      {done && !failure && (
        <Notice tone="success" className="mt-2">
          {done}
        </Notice>
      )}
    </div>
  )
}

function describe(target: ResetTarget, files: readonly BuiltinMemoryFile[]) {
  const sizes = new Map(files.map((file) => [file.name, file.bytes]))
  return RESET_FILES[target]
    .map((key) => {
      const bytes = sizes.get(key)
      const label = FILE_LABEL[key] ?? key
      return bytes ? `${label} (${formatBytes(bytes)})` : label
    })
    .join(' и ')
}
