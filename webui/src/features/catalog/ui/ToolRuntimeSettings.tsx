import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint, SectionCard } from '@/shared/ui/page'
import { SkeletonCards, SkeletonRows } from '@/shared/ui/skeleton'
import { buildToolSettingsPatch, toolSettingsFields } from '../model/config-fields'
import type {
  ComputerUseStatus,
  ConfigField,
  TerminalBackends,
  ToolPolicyConfig,
} from '../model/types'
import { StatusPill } from './chips'

const EMPTY_DRAFT: Record<string, string> = {}

/** Cross-cutting tool runtime: execution backend, computer use, search и лимиты. */
export function ToolRuntimeSettings({
  backends,
  backendsPending,
  backendsError,
  computerUse,
  computerUsePending,
  computerUseError,
  policy,
  schema,
  schemaPending,
  schemaError,
  busy,
  error,
  onSelectBackend,
  onGrantComputerUse,
  onSaveSettings,
}: {
  backends: TerminalBackends | undefined
  backendsPending: boolean
  backendsError: string | null
  computerUse: ComputerUseStatus | undefined
  computerUsePending: boolean
  computerUseError: string | null
  policy: ToolPolicyConfig | undefined
  schema: Record<string, ConfigField> | undefined
  schemaPending: boolean
  schemaError: string | null
  busy: string | null
  error: string | null
  onSelectBackend: (backend: string) => void
  onGrantComputerUse: () => void
  onSaveSettings: (patch: Record<string, unknown>) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Record<string, string>>(EMPTY_DRAFT)
  const [invalid, setInvalid] = useState<string[]>([])
  const fields = useMemo(
    () => (schema && policy ? toolSettingsFields(schema, policy) : []),
    [policy, schema],
  )

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      const { patch, invalid: bad } = buildToolSettingsPatch(fields, draft)
      setInvalid(bad)
      if (bad.length || !patch) return
      const saved = await onSaveSettings(patch)
      if (saved) setDraft(EMPTY_DRAFT)
    },
    [draft, fields, onSaveSettings],
  )

  const dirty = fields.some((field) => draft[field.path] !== undefined)
  const backendsPane = backendsPending
    ? 'skeleton'
    : backendsError
      ? 'error'
      : backends?.backends.length
        ? 'ready'
        : 'empty'
  const cuPane = computerUsePending
    ? 'skeleton'
    : computerUseError
      ? 'error'
      : computerUse
        ? 'ready'
        : 'empty'
  const settingsPane = schemaPending
    ? 'skeleton'
    : schemaError
      ? 'error'
      : fields.length
        ? 'ready'
        : 'empty'

  return (
    <div className="space-y-4">
      {error && <Notice>{error}</Notice>}

      <SectionCard title="терминал" hint="где hermes исполняет команды набора terminal">
        <SwapPane pane={backendsPane}>
          {backendsPane === 'skeleton' ? (
            <SkeletonRows rows={4} label="читаем бэкенды" />
          ) : backendsPane === 'error' ? (
            <Notice>{backendsError}</Notice>
          ) : backendsPane === 'empty' ? (
            <EmptyHint>бэкендов нет</EmptyHint>
          ) : (
            <div className="space-y-2">
              {backends?.backends.map((backend) => (
                <button
                  key={backend.name}
                  type="button"
                  disabled={backend.active || busy === `backend:${backend.name}`}
                  data-selected={String(backend.active)}
                  aria-pressed={backend.active}
                  className="card-interactive block w-full rounded-xl border border-line bg-ink/25 px-3 py-2.5 text-left"
                  onClick={() => onSelectBackend(backend.name)}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-paper">
                      {backend.label || backend.name}
                    </span>
                    <span className="font-mono text-[10px] text-mute">{backend.name}</span>
                    <StatusPill status={backend.status} />
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-mute">
                    {backend.detail || backend.description}
                  </p>
                </button>
              ))}
            </div>
          )}
        </SwapPane>
      </SectionCard>

      <SectionCard title="computer use" hint="драйвер управления экраном и его проверки">
        <SwapPane pane={cuPane}>
          {cuPane === 'skeleton' ? (
            <SkeletonCards count={2} height="h-20" label="проверяем computer use" />
          ) : cuPane === 'error' ? (
            <Notice>{computerUseError}</Notice>
          ) : cuPane === 'empty' ? (
            <EmptyHint>статус недоступен</EmptyHint>
          ) : computerUse ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={computerUse.ready ? 'ready' : 'needs_setup'} />
                <span className="font-mono text-[11px] text-mute">
                  {computerUse.version || 'драйвер не установлен'} · {computerUse.platform}
                </span>
              </div>
              <div className="mt-2 overflow-hidden rounded-xl border border-line">
                {computerUse.checks.map((check) => (
                  <div
                    key={check.label}
                    className="flex items-start gap-3 border-b border-line/60 px-3 py-2 last:border-0"
                  >
                    <span className="w-24 shrink-0 text-[11px] text-mute">{check.label}</span>
                    <span className="min-w-0 flex-1 text-[11px] leading-4 text-paper">
                      {check.message}
                    </span>
                    <StatusPill status={check.status} />
                  </div>
                ))}
                {!computerUse.checks.length && (
                  <p className="px-3 py-4 text-[11px] text-mute">проверок нет</p>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!computerUse.canGrant || busy === 'computer-use-grant'}
                  onClick={onGrantComputerUse}
                >
                  {busy === 'computer-use-grant' ? 'запрашиваем…' : 'выдать доступ'}
                </Button>
                {!computerUse.canGrant && (
                  <span className="text-[11px] text-mute">
                    выдача прав — понятие macOS; здесь их выдавать нечему
                  </span>
                )}
              </div>
            </>
          ) : null}
        </SwapPane>
      </SectionCard>

      <SectionCard
        title="поиск по тулам и лимиты вывода"
        hint="поля берутся из /api/config/schema — ровно то, что примет гейтвей"
      >
        <SwapPane pane={settingsPane}>
          {settingsPane === 'skeleton' ? (
            <SkeletonRows rows={5} label="читаем схему конфигурации" />
          ) : settingsPane === 'error' ? (
            <Notice>{schemaError}</Notice>
          ) : settingsPane === 'empty' ? (
            <EmptyHint>гейтвей не описывает эти поля</EmptyHint>
          ) : (
            <form onSubmit={submit}>
              <div className="space-y-2">
                {fields.map((field) => (
                  <label key={field.path} className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-paper">{field.label}</span>
                      <span className="block truncate font-mono text-[10px] text-mute">
                        {field.path}
                      </span>
                    </span>
                    <Input
                      type={field.type === 'number' ? 'number' : 'text'}
                      inputMode={field.type === 'number' ? 'numeric' : 'text'}
                      autoComplete="off"
                      className="h-8 w-32 shrink-0 text-xs tabular-nums"
                      value={draft[field.path] ?? field.value}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [field.path]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
              {invalid.length > 0 && (
                <Notice className="mt-2">не число: {invalid.join(', ')}</Notice>
              )}
              <div className="mt-3 flex items-center gap-2">
                <Button type="submit" size="sm" disabled={!dirty || busy === 'tool-settings'}>
                  {busy === 'tool-settings' ? 'сохраняем…' : 'сохранить'}
                </Button>
                {dirty && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft(EMPTY_DRAFT)
                      setInvalid([])
                    }}
                  >
                    сбросить
                  </Button>
                )}
              </div>
            </form>
          )}
        </SwapPane>
      </SectionCard>
    </div>
  )
}
