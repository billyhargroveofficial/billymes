import { Check, FlaskConical, KeyRound, Server, Terminal, Wrench, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/shared/lib/cn'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Switch } from '@/shared/ui/switch'
import { redactMcpArgs, redactMcpSecrets } from '../model/mcp-redaction'
import type { McpServer } from '../model/types'

export function McpServerDetail({
  server,
  pending,
  onToggle,
  onTest,
}: {
  server: McpServer
  pending: boolean
  onToggle: (enabled: boolean) => void
  onTest: () => void
}) {
  const transport = server.transport || 'не указан'
  const connectionLabel = server.url
    ? 'endpoint'
    : server.command
      ? 'command'
      : 'endpoint / command'
  const connection = redactMcpSecrets(server.url || server.command || '')
  const safeArgs = redactMcpArgs(server.args)

  return (
    <article className="min-w-0">
      <div className="mb-6 border-b border-line pb-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-mute">
          MCP SERVER · {transport}
        </div>
        <div className="mt-1 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-3xl italic leading-none text-mercury">
              {server.name}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge className="font-mono">{transport}</Badge>
              <ServerStatus enabled={server.enabled} />
              <AuthStatus configured={Boolean(server.auth)} />
            </div>
          </div>
          <Switch
            aria-label={`${server.enabled ? 'выключить' : 'включить'} MCP ${server.name}`}
            checked={server.enabled}
            disabled={pending}
            onCheckedChange={onToggle}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric value={transport} label="transport" compact />
        <Metric value={String(server.args.length)} label="args" />
        <Metric
          value={server.tools === null ? '—' : String(server.tools.length)}
          label="published tools"
        />
      </div>

      <section className="mt-7">
        <SectionLabel icon={server.url ? Server : Terminal} label={connectionLabel} />
        <div className="mt-2 rounded-2xl border border-line bg-ink/30 px-3 py-3">
          <code className="block break-all font-mono text-xs leading-5 text-paper">
            {connection}
          </code>
          <p className="mt-2 text-[10px] leading-4 text-mute">
            Секреты подключения скрыты. Auth показывается только как состояние.
          </p>
        </div>
      </section>

      <section className="mt-7">
        <SectionLabel icon={Terminal} label="args" />
        <div className="mt-2 overflow-hidden rounded-2xl border border-line">
          {safeArgs.length > 0 ? (
            safeArgs.map((arg, index) => (
              <div
                key={`${index}-${arg}`}
                className="flex items-start gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="w-5 shrink-0 font-mono text-[10px] text-mute">{index + 1}</span>
                <code className="min-w-0 break-all font-mono text-xs leading-5 text-paper">
                  {redactMcpSecrets(arg)}
                </code>
              </div>
            ))
          ) : (
            <p className="px-3 py-5 text-xs leading-5 text-mute">Аргументы не заданы.</p>
          )}
        </div>
      </section>

      <section className="mt-7">
        <SectionLabel icon={Wrench} label="published tools" />
        <div className="mt-2 overflow-hidden rounded-2xl border border-line">
          {server.tools === null ? (
            <p className="px-3 py-5 text-xs leading-5 text-mute">
              Сервер не сообщил список опубликованных tools.
            </p>
          ) : server.tools.length > 0 ? (
            server.tools.map((tool, index) => (
              <div
                key={`${tool}-${index}`}
                className="flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
              >
                <span className="w-5 shrink-0 font-mono text-[10px] text-mute">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-paper">{tool}</span>
              </div>
            ))
          ) : (
            <p className="px-3 py-5 text-xs leading-5 text-mute">Опубликованных tools нет.</p>
          )}
        </div>
      </section>

      <div className="mt-7 pb-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full sm:w-auto"
          disabled={pending}
          aria-busy={pending}
          onClick={onTest}
        >
          <FlaskConical className="size-3.5" />
          {pending ? 'проверяем…' : 'проверить'}
        </Button>
      </div>
    </article>
  )
}

function ServerStatus({ enabled }: { enabled: boolean }) {
  return <StateChip ok={enabled} yes="включён" no="выключен" />
}

function AuthStatus({ configured }: { configured: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.1em]',
        configured ? 'border-ok/25 bg-ok/10 text-ok' : 'border-line bg-ink/30 text-mute',
      )}
    >
      <KeyRound className="size-3" /> auth {configured ? 'настроена' : 'не настроена'}
    </span>
  )
}

function StateChip({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  const Icon = ok ? Check : X
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.1em]',
        ok ? 'border-ok/25 bg-ok/10 text-ok' : 'border-ember/25 bg-ember/10 text-ember',
      )}
    >
      <Icon className="size-3" /> {ok ? yes : no}
    </span>
  )
}

function Metric({
  value,
  label,
  compact = false,
}: {
  value: string
  label: string
  compact?: boolean
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-ink/30 px-3 py-2.5">
      <div
        className={cn(
          'truncate text-mercury',
          compact ? 'text-sm font-medium' : 'font-display text-2xl italic',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 truncate text-[9px] uppercase tracking-[0.14em] text-mute">
        {label}
      </div>
    </div>
  )
}

function SectionLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-mute">
      <Icon className="size-3.5 text-mercury" /> {label}
    </div>
  )
}
