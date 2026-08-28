import { memo, useCallback, useState } from 'react'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Notice } from '@/shared/ui/notice'
import type { EnvVar } from '../model/types'

export type EnvRowFeedback = { tone: 'error' | 'success'; text: string } | null

/**
 * One credential row. The row owns only its draft input; the list owns busy
 * state, feedback, and the single revealed value so a secret can never linger
 * in more than one place.
 */
export const EnvKeyRow = memo(function EnvKeyRow({
  item,
  busy,
  editing,
  confirming,
  revealed,
  feedback,
  onEdit,
  onCancel,
  onSave,
  onReveal,
  onHide,
  onDelete,
}: {
  item: EnvVar
  busy: boolean
  editing: boolean
  confirming: boolean
  revealed: string | null
  feedback: EnvRowFeedback
  onEdit: (key: string) => void
  onCancel: () => void
  onSave: (key: string, value: string) => void
  onReveal: (key: string) => void
  onHide: () => void
  onDelete: (key: string) => void
}) {
  return (
    <div
      data-selected={String(item.isSet)}
      className="row-interactive border-b border-line/60 px-3 py-3 last:border-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-paper">{item.key}</code>
        {item.providerLabel && <Badge>{item.providerLabel}</Badge>}
        {item.channelManaged && <Badge>канал</Badge>}
        <span className={item.isSet ? 'text-[11px] text-ok' : 'text-[11px] text-mute'}>
          {item.isSet ? 'задан' : 'не задан'}
        </span>
        {item.isSet && item.redactedValue && (
          <code className="font-mono text-[11px] text-mute">{item.redactedValue}</code>
        )}
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-signal underline-offset-2 hover:underline"
          >
            где взять
          </a>
        )}
      </div>

      {item.description && <p className="mt-1 text-[11px] text-mute">{item.description}</p>}
      {item.tools.length > 0 && (
        <p className="mt-0.5 text-[11px] text-mute/80">тулы: {item.tools.join(', ')}</p>
      )}

      {item.channelManaged ? (
        <p className="mt-1.5 text-[11px] text-mute/80">
          редактируется в настройках канала — здесь только чтение
        </p>
      ) : editing ? (
        <EnvKeyEditor item={item} busy={busy} onSave={onSave} onCancel={onCancel} />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onEdit(item.key)}>
            {item.isSet ? 'изменить' : 'задать'}
          </Button>
          {item.isSet && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => (revealed == null ? onReveal(item.key) : onHide())}
            >
              {revealed == null ? 'показать' : 'скрыть'}
            </Button>
          )}
          {item.isSet && (
            <Button
              type="button"
              variant={confirming ? 'ember' : 'ghost'}
              size="sm"
              disabled={busy}
              onClick={() => onDelete(item.key)}
            >
              {confirming ? 'точно удалить?' : 'удалить'}
            </Button>
          )}
        </div>
      )}

      {revealed != null && (
        <code className="mt-2 block break-all rounded-xl border border-ember/40 bg-ink/60 px-3 py-2 font-mono text-xs text-paper">
          {revealed}
        </code>
      )}

      {feedback && (
        <Notice tone={feedback.tone} className="mt-2">
          {feedback.text}
        </Notice>
      )}
    </div>
  )
})

/**
 * Mounted only while the row is in edit mode, so the draft value lives exactly
 * as long as the editing session and never needs to be reset.
 */
const EnvKeyEditor = memo(function EnvKeyEditor({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item: EnvVar
  busy: boolean
  onSave: (key: string, value: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState('')
  const save = useCallback(() => {
    if (draft.trim()) onSave(item.key, draft.trim())
  }, [draft, item.key, onSave])

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        aria-label={`значение ${item.key}`}
        type={item.isPassword ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="новое значение"
        className="min-w-0 flex-1 font-mono sm:max-w-96"
      />
      <Button
        type="button"
        variant="mercury"
        size="sm"
        disabled={busy || !draft.trim()}
        onClick={save}
      >
        {busy ? 'сохраняем…' : 'сохранить'}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
        отмена
      </Button>
    </div>
  )
})
