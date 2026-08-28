import { useState } from 'react'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Sheet } from '@/shared/ui/sheet'
import { cn } from '@/shared/lib/cn'
import { gatewayApi } from '../api/gateway-api'
import { hostFromOrigin, type GatewaySettings } from '../model/gateway-settings'
import { useGateway } from '../model/use-gateway'

export function GatewaySheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { settings, runtime, apply } = useGateway()
  const [draft, setDraft] = useState<GatewaySettings>(settings)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)

  function openSheet(next: boolean) {
    if (next) {
      setDraft(settings)
      setNote(null)
      setOk(null)
    }
    onOpenChange(next)
  }

  async function connect(next: GatewaySettings) {
    setBusy(true)
    setNote(null)
    setOk(null)
    try {
      await apply(next)
      const health = await gatewayApi.health()
      setOk(true)
      setNote(`живо · ${health.version}`)
    } catch (err) {
      setOk(false)
      setNote(err instanceof Error ? err.message : 'не подключилось')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={openSheet} title="гейтвей" className="w-[min(92vw,28rem)]">
      <p className="mb-4 text-sm leading-6 text-mute">
        Локальный туннель из `.env`, или отдельный dashboard URL с Host и токеном.
      </p>

      <button
        type="button"
        aria-pressed={draft.mode === 'local'}
        data-selected={draft.mode === 'local'}
        onClick={() => setDraft((d) => ({ ...d, mode: 'local' }))}
        className="card-interactive mb-2 w-full rounded-2xl border border-line bg-raised/40 px-3 py-3 text-left"
      >
        <div className="text-sm">локальный туннель</div>
        <div className="mt-1 font-mono text-[11px] text-mute">
          {runtime?.usingDefault !== false ? runtime?.origin || '.env · pnpm dev' : 'сброс на .env'}
        </div>
      </button>

      <button
        type="button"
        aria-pressed={draft.mode === 'remote'}
        data-selected={draft.mode === 'remote'}
        onClick={() => setDraft((d) => ({ ...d, mode: 'remote' }))}
        className="card-interactive mb-4 w-full rounded-2xl border border-line bg-raised/40 px-3 py-3 text-left"
      >
        <div className="text-sm">удалённый</div>
        <div className="mt-1 font-mono text-[11px] text-mute">
          {draft.origin || 'http://host:9119'}
        </div>
      </button>

      {draft.mode === 'remote' && (
        <div className="mb-4 space-y-3">
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-mute">URL</div>
            <Input
              name="gateway-origin"
              autoComplete="off"
              value={draft.origin}
              placeholder="http://hermes-host:9119"
              onChange={(e) => {
                const origin = e.target.value
                setDraft((d) => ({
                  ...d,
                  origin,
                  host:
                    d.host && d.host !== hostFromOrigin(d.origin) ? d.host : hostFromOrigin(origin),
                  token: origin === d.origin ? d.token : '',
                }))
              }}
            />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-mute">Host</div>
            <Input
              name="gateway-host"
              autoComplete="off"
              value={draft.host}
              placeholder="127.0.0.2:9119"
              onChange={(e) => {
                const host = e.target.value
                setDraft((d) => ({
                  ...d,
                  host,
                  token: host === d.host ? d.token : '',
                }))
              }}
            />
            <p className="mt-1 text-[11px] text-mute">
              Hermes dashboard часто ждёт Host `127.0.0.2:9119`
            </p>
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-mute">Bearer</div>
            <Input
              name="gateway-token"
              type="password"
              autoComplete="off"
              value={draft.token}
              placeholder="access token"
              onChange={(e) => setDraft((d) => ({ ...d, token: e.target.value }))}
            />
          </label>
        </div>
      )}

      {note && (
        <p
          role={ok ? 'status' : 'alert'}
          aria-live="polite"
          className={cn('mb-3 text-xs', ok ? 'text-ok' : 'text-ember')}
        >
          {note}
        </p>
      )}

      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void connect(draft)}>
          {busy ? 'подключаем…' : 'подключить'}
        </Button>
        {settings.mode === 'remote' && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void connect({ mode: 'local', origin: '', host: '', token: '' })}
          >
            на туннель
          </Button>
        )}
      </div>
    </Sheet>
  )
}
