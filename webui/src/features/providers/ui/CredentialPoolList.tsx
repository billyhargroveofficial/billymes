import { useQueryClient } from '@tanstack/react-query'
import { memo, useCallback, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { StaggerItem } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { providersApi } from '../api/providers-api'
import { paneState } from '../model/pane-state'
import { poolSourceLabel } from '../model/pool-view'
import { providerKeys } from '../model/provider-keys'
import type { PoolEntry, PoolProvider } from '../model/types'
import { SectionPane } from './SectionPane'

const EMPTY: PoolProvider[] = []
const SUGGESTIONS_ID = 'credential-pool-providers'

export function CredentialPoolList({
  profile,
  pool = EMPTY,
  suggestions,
  pending,
  loadError,
}: {
  profile: string
  pool: PoolProvider[] | undefined
  suggestions: string[]
  pending: boolean
  loadError: string | null
}) {
  const qc = useQueryClient()
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerKeys.pool() })
    void qc.invalidateQueries({ queryKey: providerKeys.oauth(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.env(profile) })
  }, [profile, qc])

  const add = useCallback(async () => {
    if (!provider.trim() || !apiKey.trim()) return
    setBusy('add')
    setFeedback(null)
    try {
      await providersApi.addPoolEntry(provider.trim().toLowerCase(), apiKey.trim(), label)
      setApiKey('')
      setLabel('')
      setFeedback({ tone: 'success', text: 'ключ добавлен в пул' })
      invalidate()
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось добавить ключ') })
    } finally {
      setBusy(null)
    }
  }, [apiKey, invalidate, label, provider])

  const remove = useCallback(
    async (providerId: string, index: number) => {
      const rowId = `${providerId}:${index}`
      if (confirmId !== rowId) {
        setConfirmId(rowId)
        return
      }
      setConfirmId(null)
      setBusy(rowId)
      setFeedback(null)
      try {
        await providersApi.removePoolEntry(providerId, index)
        invalidate()
      } catch (error) {
        setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось убрать ключ') })
      } finally {
        setBusy(null)
      }
    },
    [confirmId, invalidate],
  )

  const state = paneState({ pending, error: loadError, empty: pool.length === 0 })

  return (
    <div className="space-y-3">
      <SectionPane
        state={state}
        skeleton={<SkeletonRows rows={3} label="загружаем пул" />}
        error={loadError}
        empty="пул пуст — добавь ключ ниже"
      >
        <div className="space-y-2">
          {pool.map((group, index) => (
            <StaggerItem key={group.provider} index={index}>
              <section className="overflow-hidden rounded-2xl border border-line">
                <header className="flex items-center gap-2 bg-raised/40 px-3 py-2">
                  <span className="font-mono text-xs text-paper">{group.provider}</span>
                  <span className="ml-auto font-mono text-[11px] tabular-nums text-mute">
                    {group.entries.length}
                  </span>
                </header>
                {group.entries.map((entry) => (
                  <PoolEntryRow
                    key={`${group.provider}:${entry.index}`}
                    provider={group.provider}
                    entry={entry}
                    busy={busy === `${group.provider}:${entry.index}`}
                    confirming={confirmId === `${group.provider}:${entry.index}`}
                    onRemove={remove}
                  />
                ))}
              </section>
            </StaggerItem>
          ))}
        </div>
      </SectionPane>

      <div className="rounded-2xl border border-line bg-raised/30 p-3">
        <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-mute">добавить ключ</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="провайдер"
            list={SUGGESTIONS_ID}
            autoComplete="off"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="провайдер"
            className="font-mono sm:max-w-56"
          />
          <datalist id={SUGGESTIONS_ID}>
            {suggestions.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          <Input
            aria-label="ключ"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="ключ"
            className="min-w-0 flex-1 font-mono"
          />
          <Input
            aria-label="метка"
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="метка"
            className="sm:max-w-40"
          />
          <Button
            type="button"
            variant="mercury"
            disabled={busy === 'add' || !provider.trim() || !apiKey.trim()}
            onClick={() => void add()}
          >
            {busy === 'add' ? 'добавляем…' : 'добавить'}
          </Button>
        </div>
      </div>

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
    </div>
  )
}

const PoolEntryRow = memo(function PoolEntryRow({
  provider,
  entry,
  busy,
  confirming,
  onRemove,
}: {
  provider: string
  entry: PoolEntry
  busy: boolean
  confirming: boolean
  onRemove: (provider: string, index: number) => void
}) {
  return (
    <div
      data-selected="false"
      className="row-interactive flex flex-wrap items-center gap-2 border-b border-line/60 px-3 py-2.5 last:border-0"
    >
      <span className="w-6 shrink-0 font-mono text-[10px] tabular-nums text-mercury">
        #{entry.index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm text-paper">{entry.label || entry.id}</span>
          {entry.authType && <Badge>{entry.authType}</Badge>}
          {entry.hasRefresh && <Badge>refresh</Badge>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-mute">
          {[
            poolSourceLabel(entry.source),
            entry.tokenPreview,
            `${entry.requestCount} запросов`,
            entry.lastStatus,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <Button
        type="button"
        variant={confirming ? 'ember' : 'ghost'}
        size="sm"
        disabled={busy}
        onClick={() => onRemove(provider, entry.index)}
      >
        {busy ? 'убираем…' : confirming ? 'точно убрать?' : 'убрать'}
      </Button>
    </div>
  )
})
