import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Notice } from '@/shared/ui/notice'
import { Switch } from '@/shared/ui/switch'
import type { CustomEndpointDraft } from '../model/types'

const MODELS_ID = 'custom-endpoint-models'

/** Add/update form for one OpenAI-compatible endpoint. */
export function CustomEndpointForm({
  draft,
  discovered,
  busy,
  feedback,
  onChange,
  onValidate,
  onSave,
  onReset,
}: {
  draft: CustomEndpointDraft
  discovered: string[]
  busy: 'save' | 'validate' | null
  feedback: { tone: 'error' | 'success'; text: string } | null
  onChange: (draft: CustomEndpointDraft) => void
  onValidate: () => void
  onSave: () => void
  onReset: () => void
}) {
  const patch = (values: Partial<CustomEndpointDraft>) => onChange({ ...draft, ...values })

  return (
    <div className="rounded-2xl border border-line bg-raised/30 p-3">
      <p className="mb-2 text-[11px] uppercase tracking-[0.16em] text-mute">
        {draft.id ? `правим ${draft.id}` : 'новый эндпоинт'}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="название"
          autoComplete="off"
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
          placeholder="название"
        />
        <Input
          aria-label="адрес эндпоинта"
          autoComplete="off"
          spellCheck={false}
          value={draft.baseUrl}
          onChange={(event) => patch({ baseUrl: event.target.value })}
          placeholder="https://host/v1"
          className="font-mono"
        />
        <Input
          aria-label="модель"
          list={MODELS_ID}
          autoComplete="off"
          spellCheck={false}
          value={draft.model}
          onChange={(event) => patch({ model: event.target.value })}
          placeholder="модель"
          className="font-mono"
        />
        <datalist id={MODELS_ID}>
          {discovered.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        <Input
          aria-label="ключ доступа"
          type="password"
          autoComplete="off"
          value={draft.apiKey}
          onChange={(event) => patch({ apiKey: event.target.value })}
          placeholder={draft.id ? 'ключ — оставь пустым, чтобы не менять' : 'ключ (если нужен)'}
          className="font-mono"
        />
        <Input
          aria-label="контекст"
          inputMode="numeric"
          autoComplete="off"
          value={draft.contextLength}
          onChange={(event) => patch({ contextLength: event.target.value.replace(/\D/g, '') })}
          placeholder="контекст, токенов"
          className="tabular-nums"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-mute">
          <Switch
            aria-label="запрашивать список моделей у эндпоинта"
            checked={draft.discoverModels}
            onCheckedChange={(checked) => patch({ discoverModels: checked })}
          />
          спрашивать модели
        </label>
        <label className="flex items-center gap-2 text-xs text-mute">
          <Switch
            aria-label="сделать основным провайдером"
            checked={draft.makeDefault}
            onCheckedChange={(checked) => patch({ makeDefault: checked })}
          />
          сделать основным
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={onValidate}
        >
          {busy === 'validate' ? 'проверяем…' : 'проверить'}
        </Button>
        <Button type="button" variant="mercury" size="sm" disabled={busy !== null} onClick={onSave}>
          {busy === 'save' ? 'сохраняем…' : 'сохранить'}
        </Button>
        {draft.id && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={onReset}
          >
            новый
          </Button>
        )}
      </div>

      {discovered.length > 0 && (
        <p className="mt-2 truncate text-[11px] text-mute">
          эндпоинт отдал {discovered.length} моделей: {discovered.slice(0, 4).join(', ')}
        </p>
      )}
      {feedback && (
        <Notice tone={feedback.tone} className="mt-2">
          {feedback.text}
        </Notice>
      )}
    </div>
  )
}
