import { Check, ExternalLink, KeyRound } from 'lucide-react'
import { useCallback, useState, type FormEvent } from 'react'
import { cn } from '@/shared/lib/cn'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import type { ActionStatus, ToolsetProvider } from '../model/types'
import { StatusPill } from './chips'

const EMPTY_VALUES: Record<string, string> = {}

/**
 * One provider of a toolset: pick it, fill its API keys, run its install hook.
 * Key values are write-only — Hermes never returns them, and this component
 * never keeps one after the save resolves.
 */
export function ToolsetProviderRow({
  provider,
  selected,
  web,
  searchActive,
  extractActive,
  busyAction,
  postSetupKey,
  postSetupStatus,
  onInspect,
  onSelect,
  onSaveEnv,
  onPostSetup,
}: {
  provider: ToolsetProvider
  selected: boolean
  web: boolean
  searchActive: boolean
  extractActive: boolean
  busyAction: string | null
  /** the post-setup key this session launched, if any */
  postSetupKey: string | null
  postSetupStatus: ActionStatus | undefined
  onInspect: () => void
  onSelect: (capability?: 'search' | 'extract') => void
  onSaveEnv: (values: Record<string, string>) => Promise<boolean>
  onPostSetup: (key: string) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(EMPTY_VALUES)
  const ready = provider.status === 'ready'
  const busy = busyAction?.startsWith(`provider:${provider.name}`) ?? false
  const envBusy = busyAction === `env:${provider.name}`
  const setupBusy = busyAction === `post-setup:${provider.name}`
  const keyed = provider.envVars.filter((item) => item.isSet || item.hasDefault).length
  const filled = Object.values(values).some((value) => value.trim())

  const submitEnv = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const saved = await onSaveEnv(values)
      if (saved) setValues(EMPTY_VALUES)
    },
    [onSaveEnv, values],
  )

  return (
    <div
      data-selected={String(selected)}
      className="card-interactive rounded-2xl border border-line bg-ink/25 px-3 py-3"
    >
      <button type="button" className="block w-full text-left" onClick={onInspect}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-paper">{provider.name}</div>
            <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-mute">
              {provider.badge || provider.webBackend || provider.ttsProvider || 'provider'}
            </div>
          </div>
          <StatusPill status={provider.status} />
        </div>
        {provider.tag && <p className="mt-2 text-[11px] leading-4 text-mute">{provider.tag}</p>}
      </button>

      {provider.envVars.length > 0 && (
        <form className="mt-2 border-t border-line/60 pt-2" onSubmit={submitEnv}>
          <div className="flex items-center gap-1.5 text-[10px] text-mute">
            <KeyRound aria-hidden="true" className="size-3" /> {keyed}/{provider.envVars.length}{' '}
            настроено
          </div>
          <div className="mt-2 space-y-2">
            {provider.envVars.map((env) => (
              <label key={env.key} className="block">
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-mute">
                  {(env.isSet || env.hasDefault) && (
                    <Check aria-hidden="true" className="size-2.5 text-ok" />
                  )}
                  {env.key}
                  {env.url && (
                    <a
                      href={env.url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`где взять ${env.key}`}
                      className="text-signal"
                    >
                      <ExternalLink aria-hidden="true" className="size-2.5" />
                    </a>
                  )}
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-1 h-8 text-xs"
                  placeholder={env.isSet ? 'значение задано — введи новое' : env.prompt || env.key}
                  value={values[env.key] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [env.key]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button type="submit" size="sm" variant="outline" disabled={!filled || envBusy}>
              {envBusy ? 'сохраняем…' : 'сохранить ключи'}
            </Button>
            <span className="text-[10px] text-mute">пишется в ~/.hermes/.env</span>
          </div>
        </form>
      )}

      {provider.postSetup && (
        <div className="mt-2 border-t border-line/60 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={setupBusy}
              onClick={() => onPostSetup(provider.postSetup!)}
            >
              {setupBusy ? 'запускаем…' : 'доустановить'}
            </Button>
            <span className="font-mono text-[9px] text-mute">
              hermes tools post-setup {provider.postSetup}
            </span>
          </div>
          {postSetupKey === provider.postSetup && postSetupStatus && (
            <PostSetupTail status={postSetupStatus} />
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {web ? (
          <>
            {provider.capabilities.includes('search') && (
              <ProviderButton
                active={searchActive}
                disabled={!ready || busy}
                busy={busyAction === `provider:${provider.name}:search`}
                label="поиск"
                onClick={() => onSelect('search')}
              />
            )}
            {provider.capabilities.includes('extract') && (
              <ProviderButton
                active={extractActive}
                disabled={!ready || busy}
                busy={busyAction === `provider:${provider.name}:extract`}
                label="извлечение"
                onClick={() => onSelect('extract')}
              />
            )}
          </>
        ) : (
          <ProviderButton
            active={provider.isActive}
            disabled={!ready || busy}
            busy={busyAction === `provider:${provider.name}`}
            label="провайдер"
            onClick={() => onSelect()}
          />
        )}
      </div>
    </div>
  )
}

function PostSetupTail({ status }: { status: ActionStatus }) {
  const last = status.lines.at(-1) ?? ''
  return (
    <div className="mt-2 rounded-xl border border-line bg-ink/40 px-2.5 py-2">
      <div
        className={cn(
          'text-[10px] uppercase tracking-[0.12em]',
          status.running ? 'text-mute' : status.exitCode === 0 ? 'text-ok' : 'text-ember',
        )}
      >
        {status.running
          ? 'установка идёт'
          : status.exitCode === 0
            ? 'установка завершена'
            : `установка упала · код ${status.exitCode ?? '—'}`}
      </div>
      {last && <p className="mt-1 truncate font-mono text-[10px] text-mute">{last}</p>}
    </div>
  )
}

function ProviderButton({
  active,
  disabled,
  busy,
  label,
  onClick,
}: {
  active: boolean
  disabled: boolean
  busy: boolean
  label: string
  onClick: () => void
}) {
  return (
    <Button
      size="sm"
      variant={active ? 'default' : 'outline'}
      disabled={disabled || active}
      onClick={onClick}
    >
      {active ? <Check aria-hidden="true" className="mr-1 size-3" /> : null}
      {busy ? 'сохраняем…' : active ? `${label} активен` : `выбрать: ${label}`}
    </Button>
  )
}
