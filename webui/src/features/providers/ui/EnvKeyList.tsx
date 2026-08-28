import { useQueryClient } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { Input } from '@/shared/ui/input'
import { StaggerItem } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import { providersApi } from '../api/providers-api'
import { probeVerdict } from '../model/endpoint-draft'
import { groupEnvVars, hiddenAdvancedCount } from '../model/env-groups'
import { paneState } from '../model/pane-state'
import { providerKeys } from '../model/provider-keys'
import type { EnvVar } from '../model/types'
import { EnvKeyRow } from './EnvKeyRow'
import { SectionPane } from './SectionPane'

const EMPTY: EnvVar[] = []

type Feedback = { key: string; tone: 'error' | 'success'; text: string }

export function EnvKeyList({
  profile,
  vars = EMPTY,
  pending,
  loadError,
  query,
  onQueryChange,
  showAdvanced,
  onShowAdvancedChange,
  openCategory,
  onOpenCategory,
}: {
  profile: string
  vars: EnvVar[] | undefined
  pending: boolean
  loadError: string | null
  query: string
  onQueryChange: (value: string) => void
  showAdvanced: boolean
  onShowAdvancedChange: (value: boolean) => void
  openCategory: string | null
  onOpenCategory: (category: string | null) => void
}) {
  const qc = useQueryClient()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const groups = useMemo(
    () => groupEnvVars(vars, { query, showAdvanced }),
    [query, showAdvanced, vars],
  )
  const hidden = useMemo(
    () => hiddenAdvancedCount(vars, { query, showAdvanced }),
    [query, showAdvanced, vars],
  )

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerKeys.env(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.pool() })
  }, [profile, qc])

  const save = useCallback(
    async (key: string, value: string) => {
      setBusyKey(key)
      setFeedback(null)
      try {
        let warning: string | null = null
        try {
          const verdict = probeVerdict(
            await providersApi.validateCredential(key, value, profile),
            'провайдер отклонил ключ',
          )
          if (verdict.kind === 'blocked') {
            setFeedback({ key, tone: 'error', text: verdict.message })
            return
          }
          if (verdict.kind === 'warn') warning = verdict.message
        } catch (error) {
          warning = errorMessage(error, 'проверить ключ не удалось')
        }
        await providersApi.setEnvVar(key, value, profile)
        setEditingKey(null)
        setRevealed(null)
        setFeedback({
          key,
          tone: warning ? 'error' : 'success',
          text: warning ? `сохранено · ${warning}` : 'ключ сохранён',
        })
        invalidate()
      } catch (error) {
        setFeedback({ key, tone: 'error', text: errorMessage(error, 'не удалось сохранить ключ') })
      } finally {
        setBusyKey(null)
      }
    },
    [invalidate, profile],
  )

  const reveal = useCallback(
    async (key: string) => {
      setBusyKey(key)
      setFeedback(null)
      try {
        setRevealed({ key, value: await providersApi.revealEnvVar(key, profile) })
      } catch (error) {
        setFeedback({ key, tone: 'error', text: errorMessage(error, 'не удалось показать ключ') })
      } finally {
        setBusyKey(null)
      }
    },
    [profile],
  )

  const remove = useCallback(
    async (key: string) => {
      if (confirmKey !== key) {
        setConfirmKey(key)
        return
      }
      setConfirmKey(null)
      setBusyKey(key)
      setFeedback(null)
      try {
        await providersApi.removeEnvVar(key, profile)
        setRevealed(null)
        invalidate()
      } catch (error) {
        setFeedback({ key, tone: 'error', text: errorMessage(error, 'не удалось удалить ключ') })
      } finally {
        setBusyKey(null)
      }
    },
    [confirmKey, invalidate, profile],
  )

  const edit = useCallback((key: string) => {
    setEditingKey(key)
    setConfirmKey(null)
    setFeedback(null)
    setRevealed(null)
  }, [])
  const cancelEdit = useCallback(() => setEditingKey(null), [])
  const hide = useCallback(() => setRevealed(null), [])

  const searching = query.trim().length > 0
  // Collapsed by default: 300+ variables are reference material, not a form.
  const expanded = openCategory
  const state = paneState({ pending, error: loadError, empty: groups.length === 0 })

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Input
          type="search"
          name="env-search"
          autoComplete="off"
          aria-label="найти ключ"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="ключ, провайдер или тул"
          className="sm:max-w-80"
        />
        <label className="flex shrink-0 items-center gap-2 text-xs text-mute">
          <Switch
            aria-label="показывать продвинутые ключи"
            checked={showAdvanced}
            onCheckedChange={onShowAdvancedChange}
          />
          продвинутые{hidden > 0 ? ` · скрыто ${hidden}` : ''}
        </label>
      </div>

      <p className="text-[11px] text-mute/80">
        значение показывается только по нажатию: не больше 5 показов за 30 секунд, каждый пишется в
        журнал гейтвея
      </p>

      <SectionPane
        state={state}
        skeleton={<SkeletonRows rows={6} label="загружаем ключи" />}
        error={loadError}
        empty={searching ? 'ничего не нашлось' : 'ключей нет'}
      >
        <div className="space-y-2">
          {groups.map((group, index) => {
            const open = searching || group.category === expanded
            return (
              <StaggerItem key={group.category} index={index}>
                <section className="overflow-hidden rounded-2xl border border-line">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => onOpenCategory(open && !searching ? null : group.category)}
                    className="card-interactive flex w-full items-center gap-2 bg-raised/40 px-3 py-2 text-left"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={`size-3.5 shrink-0 text-mute transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                    <span className="text-[11px] uppercase tracking-[0.16em] text-mute">
                      {group.label}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-1 w-12 overflow-hidden rounded-full bg-line/60"
                      >
                        <span
                          className="block h-full rounded-full bg-ok/70 transition-[width] duration-500"
                          style={{
                            width: `${group.total ? Math.round((group.setCount / group.total) * 100) : 0}%`,
                          }}
                        />
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-mute">
                        {group.setCount}/{group.total}
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div>
                      {group.vars.map((item) => (
                        <EnvKeyRow
                          key={item.key}
                          item={item}
                          busy={busyKey === item.key}
                          editing={editingKey === item.key}
                          confirming={confirmKey === item.key}
                          revealed={revealed?.key === item.key ? revealed.value : null}
                          feedback={feedback?.key === item.key ? feedback : null}
                          onEdit={edit}
                          onCancel={cancelEdit}
                          onSave={save}
                          onReveal={reveal}
                          onHide={hide}
                          onDelete={remove}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </StaggerItem>
            )
          })}
        </div>
      </SectionPane>

      {feedback &&
        !groups.some((group) => group.vars.some((item) => item.key === feedback.key)) && (
          <Notice tone={feedback.tone}>{feedback.text}</Notice>
        )}
    </div>
  )
}
