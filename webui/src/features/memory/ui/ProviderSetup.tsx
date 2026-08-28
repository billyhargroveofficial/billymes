import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { Segmented } from '@/shared/ui/segmented'
import { SkeletonBlock, SkeletonText } from '@/shared/ui/skeleton'
import { memoryApi } from '../api/memory-api'
import type { OauthState, ProviderField } from '../model/types'

const OAUTH_LABEL: Record<OauthState, string> = {
  idle: 'не подключён',
  pending: 'ждём подтверждения в браузере…',
  connected: 'подключено',
  error: 'ошибка',
}

const FIELD_INPUT =
  'h-10 w-full rounded-xl border border-line bg-ink/60 px-3 text-sm text-paper placeholder:text-mute'

/** The credentials and options one memory backend needs before it can serve. */
export function ProviderConfigForm({ name, profile }: { name: string; profile: string }) {
  const queryClient = useQueryClient()
  const config = useQuery({
    queryKey: ['memory', 'provider-config', profile, name],
    queryFn: () => memoryApi.providerConfig(name, profile),
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (values: Record<string, string>) =>
      memoryApi.saveProviderConfig(name, values, profile),
    onSuccess: async () => {
      setDraft({})
      setFailure(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['memory', 'status'] })
      await queryClient.invalidateQueries({
        queryKey: ['memory', 'provider-config', profile, name],
      })
    },
    onError: (error) => setFailure(errorMessage(error, 'не удалось сохранить настройки')),
  })

  const fields = config.data?.fields ?? []
  const dirty = Object.keys(draft).length > 0
  const pane = config.isPending
    ? 'skeleton'
    : config.error
      ? 'error'
      : fields.length
        ? 'ready'
        : 'empty'

  return (
    <SwapPane pane={pane}>
      {pane === 'skeleton' ? (
        <SkeletonBlock label="читаем настройки бэкенда" className="space-y-2">
          <SkeletonText lines={4} />
        </SkeletonBlock>
      ) : pane === 'error' ? (
        <Notice>{errorMessage(config.error, 'не удалось прочитать настройки')}</Notice>
      ) : pane === 'empty' ? (
        <p className="text-xs text-mute">у этого бэкенда нет настраиваемых полей</p>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (dirty) save.mutate(draft)
          }}
        >
          {fields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              draft={draft[field.key]}
              onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button size="sm" type="submit" disabled={!dirty || save.isPending}>
              {save.isPending ? 'сохраняем…' : 'сохранить'}
            </Button>
            <span className="text-[11px] text-mute">сохранение делает этот бэкенд активным</span>
          </div>
          {failure && <Notice className="sm:col-span-2">{failure}</Notice>}
          {saved && !failure && (
            <Notice tone="success" className="sm:col-span-2">
              настройки сохранены
            </Notice>
          )}
        </form>
      )}
    </SwapPane>
  )
}

function ConfigField({
  field,
  draft,
  onChange,
}: {
  field: ProviderField
  draft: string | undefined
  onChange: (value: string) => void
}) {
  const secret = field.kind === 'secret'
  const value = draft ?? (secret ? '' : field.value)
  const controlId = `memory-field-${field.key}`
  const wide = field.options.length === 0 && !secret && field.kind !== 'number'

  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <label htmlFor={controlId} className="text-[11px] uppercase tracking-[0.14em] text-mute">
        {field.label}
        {field.required && <span className="text-ember"> *</span>}
      </label>
      {field.description && <p className="mt-0.5 text-[11px] text-mute/80">{field.description}</p>}
      <div className="mt-1.5">
        {field.options.length === 0 ? (
          <Input
            id={controlId}
            type={secret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            placeholder={secret && field.isSet ? 'уже сохранён' : field.placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : field.options.length <= 3 ? (
          <Segmented
            label={field.label}
            value={value}
            options={field.options.map((option) => ({ value: option.value, label: option.label }))}
            onChange={onChange}
          />
        ) : (
          <select
            id={controlId}
            className={FIELD_INPUT}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

/**
 * Providers without an OAuth flow answer 404 to the status probe, so a missing
 * status means "no OAuth surface" and this block simply does not render.
 */
export function ProviderOauth({ name, profile }: { name: string; profile: string }) {
  const [failure, setFailure] = useState<string | null>(null)
  const status = useQuery({
    queryKey: ['memory', 'oauth', profile, name],
    queryFn: () => memoryApi.oauthStatus(name, profile),
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 2000 : false),
  })
  const start = useMutation({
    mutationFn: () => memoryApi.startOauth(name, profile),
    onSuccess: () => void status.refetch(),
    onError: (error) => setFailure(errorMessage(error, 'не удалось начать подключение')),
  })

  const oauth = status.data
  if (!oauth) return null

  return (
    <div className="rounded-xl border border-line bg-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-mute">подключение</span>
        <Button
          size="sm"
          variant="outline"
          disabled={start.isPending || oauth.state === 'pending'}
          onClick={() => start.mutate()}
        >
          {oauth.connected ? 'переподключить' : 'подключить'}
        </Button>
      </div>
      <p
        className={cn(
          'mt-1.5 flex items-center gap-1.5 text-xs',
          oauth.state === 'error'
            ? 'text-ember'
            : oauth.state === 'connected'
              ? 'text-ok'
              : 'text-mute',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            oauth.state === 'error'
              ? 'bg-ember'
              : oauth.state === 'connected'
                ? 'bg-ok'
                : oauth.state === 'pending'
                  ? 'bg-mercury pulse-soft'
                  : 'bg-mute',
          )}
        />
        {OAUTH_LABEL[oauth.state]}
        {oauth.detail ? ` — ${oauth.detail}` : ''}
      </p>
      {failure && <Notice className="mt-1.5">{failure}</Notice>}
    </div>
  )
}
