import { useQuery, useQueryClient } from '@tanstack/react-query'
import { memo, useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProfileScope } from '@/features/profiles'
import { cn } from '@/shared/lib/cn'
import { errorMessage } from '@/shared/lib/error-message'
import { StaggerItem, SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import { EmptyHint } from '@/shared/ui/page'
import { Sheet } from '@/shared/ui/sheet'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import { catalogApi } from '../api/catalog-api'
import { redactMcpSecrets } from '../model/mcp-redaction'
import type { McpServer } from '../model/types'
import { CatalogSplitView } from './CatalogSplitView'
import { McpServerDetail } from './McpServerDetail'

const EMPTY_SERVERS: McpServer[] = []
const MOBILE = '(max-width: 1023px)'

export function McpPage() {
  const { profile } = useProfileScope()
  const qc = useQueryClient()
  const serversQ = useQuery({ queryKey: ['mcp', profile], queryFn: () => catalogApi.mcp(profile) })
  const servers = serversQ.data?.servers ?? EMPTY_SERVERS
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const open = searchParams.get('server')
  const [mobileOpen, setMobileOpen] = useState(
    () => Boolean(open) && window.matchMedia(MOBILE).matches,
  )
  const [busyServer, setBusyServer] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...servers]
      .filter((server) => {
        if (!needle) return true
        return [server.name, server.transport, server.url, server.command]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(needle))
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  }, [query, servers])

  const selected = open ? servers.find((server) => server.name === open) : undefined

  const updateRoute = useCallback(
    (key: 'q' | 'server', value: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const mutate = useCallback(
    async (name: string, action: () => Promise<unknown>, success?: string) => {
      setBusyServer(name)
      setNotice(null)
      try {
        await action()
        await qc.invalidateQueries({ queryKey: ['mcp', profile] })
        if (success) setNotice({ text: success, ok: true })
      } catch (error) {
        setNotice({ text: errorMessage(error, `операция MCP ${name} не выполнена`), ok: false })
      } finally {
        setBusyServer(null)
      }
    },
    [profile, qc],
  )

  const onSelect = useCallback(
    (name: string) => {
      updateRoute('server', name)
      if (window.matchMedia(MOBILE).matches) setMobileOpen(true)
    },
    [updateRoute],
  )

  const onToggle = useCallback(
    (name: string, enabled: boolean) => {
      void mutate(name, () => catalogApi.toggleMcp(name, enabled, profile))
    },
    [mutate, profile],
  )

  const loadError = serversQ.error ? errorMessage(serversQ.error, 'не удалось загрузить MCP') : null
  const listPane = serversQ.isPending
    ? 'skeleton'
    : loadError
      ? 'error'
      : rows.length
        ? 'ready'
        : 'empty'

  const detail = selected ? (
    <>
      {notice && (
        <Notice tone={notice.ok ? 'success' : 'error'} className="mb-4 lg:hidden">
          {notice.text}
        </Notice>
      )}
      <McpServerDetail
        server={selected}
        pending={busyServer === selected.name}
        onToggle={(enabled) => onToggle(selected.name, enabled)}
        onTest={() =>
          void mutate(
            selected.name,
            () => catalogApi.testMcp(selected.name, profile),
            `MCP ${selected.name} отвечает`,
          )
        }
      />
    </>
  ) : (
    <EmptyHint>выбери MCP сервер — справа откроются его настройки</EmptyHint>
  )

  return (
    <>
      <CatalogSplitView
        eyebrow="протоколы"
        title={`MCP · ${servers.length}`}
        searchLabel="найти MCP сервер"
        query={query}
        onQueryChange={(value) => updateRoute('q', value)}
        detail={detail}
      >
        {notice && (
          <Notice tone={notice.ok ? 'success' : 'error'} className="mb-3">
            {notice.text}
          </Notice>
        )}

        <SwapPane pane={listPane}>
          {listPane === 'skeleton' ? (
            <SkeletonRows rows={6} label="загружаем MCP серверы" />
          ) : listPane === 'error' ? (
            <Notice>{loadError}</Notice>
          ) : listPane === 'empty' ? (
            <EmptyHint>
              {servers.length ? 'по запросу MCP серверов нет' : 'MCP серверов нет'}
            </EmptyHint>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line">
              {rows.map((server, index) => (
                <StaggerItem key={server.name} index={index}>
                  <McpRow
                    server={server}
                    rank={index + 1}
                    selected={open === server.name}
                    busy={busyServer === server.name}
                    onSelect={onSelect}
                    onToggle={onToggle}
                  />
                </StaggerItem>
              ))}
            </div>
          )}
        </SwapPane>
      </CatalogSplitView>

      {selected && (
        <Sheet
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          title="MCP сервер"
          className="w-[min(94vw,38rem)]"
        >
          {detail}
        </Sheet>
      )}
    </>
  )
}

const McpRow = memo(function McpRow({
  server,
  rank,
  selected,
  busy,
  onSelect,
  onToggle,
}: {
  server: McpServer
  rank: number
  selected: boolean
  busy: boolean
  onSelect: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  return (
    <div
      data-selected={String(selected)}
      className="row-interactive flex items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0"
    >
      <span className="w-7 shrink-0 pl-1 font-mono text-[10px] text-mercury tabular-nums">
        #{rank}
      </span>
      <button
        type="button"
        aria-pressed={selected}
        className={cn('min-w-0 flex-1 text-left', !server.enabled && 'opacity-60')}
        onClick={() => onSelect(server.name)}
      >
        <div className="truncate font-medium">{server.name}</div>
        <div className="truncate text-[11px] text-mute">
          {server.transport || 'transport —'} ·{' '}
          {redactMcpSecrets(server.url || server.command || 'не настроен')}
        </div>
      </button>
      <span className="shrink-0 font-mono text-xs tabular-nums text-paper">
        {server.tools === null ? '—' : `${server.tools.length}×`}
      </span>
      <Switch
        aria-label={`${server.enabled ? 'выключить' : 'включить'} MCP ${server.name}`}
        checked={server.enabled}
        disabled={busy}
        onCheckedChange={(enabled) => onToggle(server.name, enabled)}
      />
    </div>
  )
})
