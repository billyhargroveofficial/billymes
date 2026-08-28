import { useQueryClient } from '@tanstack/react-query'
import { memo, useCallback, useState } from 'react'
import { errorMessage } from '@/shared/lib/error-message'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { StaggerItem } from '@/shared/ui/motion'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { providersApi } from '../api/providers-api'
import {
  EMPTY_ENDPOINT_DRAFT,
  draftFromEndpoint,
  endpointDraftError,
  probeVerdict,
} from '../model/endpoint-draft'
import { paneState } from '../model/pane-state'
import { providerKeys } from '../model/provider-keys'
import type { CustomEndpoint, CustomEndpointDraft, CustomEndpointsPayload } from '../model/types'
import { CustomEndpointForm } from './CustomEndpointForm'
import { SectionPane } from './SectionPane'

const NO_MODELS: string[] = []
const NO_ENDPOINTS: CustomEndpoint[] = []
type Feedback = { tone: 'error' | 'success'; text: string } | null

export function CustomEndpointList({
  profile,
  payload,
  pending,
  loadError,
}: {
  profile: string
  payload: CustomEndpointsPayload | undefined
  pending: boolean
  loadError: string | null
}) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<CustomEndpointDraft>(EMPTY_ENDPOINT_DRAFT)
  const [discovered, setDiscovered] = useState<string[]>(NO_MODELS)
  const [formBusy, setFormBusy] = useState<'save' | 'validate' | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const endpoints = payload?.endpoints ?? NO_ENDPOINTS
  const current = payload?.current

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: providerKeys.endpoints(profile) })
    void qc.invalidateQueries({ queryKey: providerKeys.env(profile) })
  }, [profile, qc])

  const runValidate = useCallback(async () => {
    if (!draft.baseUrl.trim()) {
      setFeedback({ tone: 'error', text: 'укажи адрес эндпоинта' })
      return
    }
    setFormBusy('validate')
    setFeedback(null)
    try {
      const result = await providersApi.validateCustomEndpoint(draft)
      setDiscovered(result.models.length > 0 ? result.models : NO_MODELS)
      const verdict = probeVerdict(result, 'эндпоинт не ответил как надо')
      setFeedback({ tone: verdict.kind === 'ok' ? 'success' : 'error', text: verdict.message })
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'проверка не удалась') })
    } finally {
      setFormBusy(null)
    }
  }, [draft])

  const save = useCallback(async () => {
    const invalid = endpointDraftError(draft)
    if (invalid) {
      setFeedback({ tone: 'error', text: invalid })
      return
    }
    setFormBusy('save')
    setFeedback(null)
    try {
      let warning: string | null = null
      try {
        const verdict = probeVerdict(
          await providersApi.validateCustomEndpoint(draft),
          'эндпоинт не ответил как надо',
        )
        if (verdict.kind === 'blocked') {
          setFeedback({ tone: 'error', text: verdict.message })
          return
        }
        if (verdict.kind === 'warn') warning = verdict.message
      } catch (error) {
        warning = errorMessage(error, 'проверить эндпоинт не удалось')
      }
      await providersApi.saveCustomEndpoint(draft, profile)
      setDraft(EMPTY_ENDPOINT_DRAFT)
      setDiscovered(NO_MODELS)
      setFeedback({
        tone: warning ? 'error' : 'success',
        text: warning ? `сохранено · ${warning}` : 'эндпоинт сохранён',
      })
      invalidate()
    } catch (error) {
      setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось сохранить эндпоинт') })
    } finally {
      setFormBusy(null)
    }
  }, [draft, invalidate, profile])

  const activate = useCallback(
    async (endpoint: CustomEndpoint) => {
      setRowBusy(endpoint.id)
      setFeedback(null)
      try {
        await providersApi.activateCustomEndpoint(endpoint.id, profile)
        invalidate()
      } catch (error) {
        setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось назначить основным') })
      } finally {
        setRowBusy(null)
      }
    },
    [invalidate, profile],
  )

  const remove = useCallback(
    async (endpoint: CustomEndpoint) => {
      if (confirmId !== endpoint.id) {
        setConfirmId(endpoint.id)
        return
      }
      setConfirmId(null)
      setRowBusy(endpoint.id)
      setFeedback(null)
      try {
        await providersApi.deleteCustomEndpoint(endpoint.id, profile)
        invalidate()
      } catch (error) {
        setFeedback({ tone: 'error', text: errorMessage(error, 'не удалось удалить эндпоинт') })
      } finally {
        setRowBusy(null)
      }
    },
    [confirmId, invalidate, profile],
  )

  const edit = useCallback((endpoint: CustomEndpoint) => {
    setConfirmId(null)
    setDraft(draftFromEndpoint(endpoint))
    setDiscovered(endpoint.models.length > 0 ? endpoint.models : NO_MODELS)
    setFeedback(null)
  }, [])

  const reset = useCallback(() => {
    setDraft(EMPTY_ENDPOINT_DRAFT)
    setDiscovered(NO_MODELS)
    setFeedback(null)
  }, [])

  const state = paneState({ pending, error: loadError, empty: endpoints.length === 0 })

  return (
    <div className="space-y-3">
      {current && (
        <p className="text-[11px] text-mute">
          сейчас основной: <span className="font-mono text-paper">{current.provider || '—'}</span>
          {current.model ? ` / ${current.model}` : ''}
          {current.baseUrl ? ` · ${current.baseUrl}` : ''}
        </p>
      )}

      <SectionPane
        state={state}
        skeleton={<SkeletonRows rows={3} label="загружаем эндпоинты" />}
        error={loadError}
        empty="своих эндпоинтов нет — добавь ниже"
      >
        <div className="overflow-hidden rounded-2xl border border-line">
          {endpoints.map((endpoint, index) => (
            <StaggerItem key={endpoint.id} index={index}>
              <EndpointRow
                endpoint={endpoint}
                busy={rowBusy === endpoint.id}
                confirming={confirmId === endpoint.id}
                onEdit={edit}
                onActivate={activate}
                onRemove={remove}
              />
            </StaggerItem>
          ))}
        </div>
      </SectionPane>

      <CustomEndpointForm
        draft={draft}
        discovered={discovered}
        busy={formBusy}
        feedback={feedback}
        onChange={setDraft}
        onValidate={() => void runValidate()}
        onSave={() => void save()}
        onReset={reset}
      />
    </div>
  )
}

const EndpointRow = memo(function EndpointRow({
  endpoint,
  busy,
  confirming,
  onEdit,
  onActivate,
  onRemove,
}: {
  endpoint: CustomEndpoint
  busy: boolean
  confirming: boolean
  onEdit: (endpoint: CustomEndpoint) => void
  onActivate: (endpoint: CustomEndpoint) => void
  onRemove: (endpoint: CustomEndpoint) => void
}) {
  return (
    <div
      data-selected={String(endpoint.isCurrent)}
      className="row-interactive flex flex-col gap-2 border-b border-line/60 px-3 py-3 last:border-0 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm text-paper">{endpoint.name}</span>
          {endpoint.isCurrent && <Badge>основной</Badge>}
          {endpoint.hasApiKey && <Badge>ключ есть</Badge>}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-mute">{endpoint.baseUrl}</p>
        <p className="mt-0.5 truncate text-[11px] text-mute/80">
          {[
            endpoint.model,
            endpoint.models.length > 1 ? `${endpoint.models.length} моделей` : null,
            endpoint.contextLength ? `${endpoint.contextLength} токенов` : null,
            endpoint.apiKeyPreview,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onEdit(endpoint)}>
          изменить
        </Button>
        {!endpoint.isCurrent && (
          <Button
            type="button"
            variant="mercury"
            size="sm"
            disabled={busy}
            onClick={() => onActivate(endpoint)}
          >
            {busy ? 'назначаем…' : 'сделать основным'}
          </Button>
        )}
        <Button
          type="button"
          variant={confirming ? 'ember' : 'ghost'}
          size="sm"
          disabled={busy}
          onClick={() => onRemove(endpoint)}
        >
          {busy ? 'удаляем…' : confirming ? 'точно удалить?' : 'удалить'}
        </Button>
      </div>
    </div>
  )
})
