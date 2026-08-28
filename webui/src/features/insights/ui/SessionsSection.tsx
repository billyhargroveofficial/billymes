import { memo, useMemo } from 'react'
import { Notice } from '@/shared/ui/notice'
import { EASE_OUT, m, SwapPane } from '@/shared/ui/motion'
import { formatInt, formatPercent } from '../model/format'
import type { SessionStats } from '../model/types'
import { CHART_TRACK, rankColor } from './charts/palette'
import { Block } from './panel'
import { paneFor } from './pane'

const SOURCE_LABELS: Record<string, string> = {
  cli: 'cli',
  desktop: 'десктоп',
  telegram: 'telegram',
  api_server: 'api',
  webui: 'веб',
  web: 'веб',
  tui: 'tui',
  gui: 'gui',
  cron: 'cron',
  unknown: 'неизвестно',
}

type SourceSlice = { key: string; label: string; count: number; share: number }

export const SessionsSection = memo(function SessionsSection({
  stats,
  pending,
  error,
}: {
  stats: SessionStats | null
  pending: boolean
  error: string | null
}) {
  const sources = useMemo<SourceSlice[]>(() => {
    if (!stats) return []
    const total = stats.bySource.reduce((sum, entry) => sum + entry.count, 0)
    return stats.bySource
      .filter((entry) => entry.count > 0 && total > 0)
      .map((entry) => ({
        key: entry.source,
        label: SOURCE_LABELS[entry.source] ?? entry.source,
        count: entry.count,
        share: (entry.count / total) * 100,
      }))
  }, [stats])

  const pane = paneFor(pending, error, !stats || stats.total === 0)
  const headline =
    stats &&
    `${formatInt(stats.total)} сессий · ${formatInt(stats.messages)} сообщений${
      stats.archived > 0 ? ` · архив ${formatInt(stats.archived)}` : ''
    }`

  return (
    <Block title="сессии">
      <SwapPane pane={pane}>
        {pane === 'skeleton' && <p className="text-sm text-mute">загружаем сессии</p>}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <p className="text-sm text-mute">сессий нет</p>}
        {pane === 'ready' && stats && (
          <div className="space-y-2">
            <p className="text-sm text-paper">{headline}</p>
            {sources.length > 0 && (
              <>
                <div
                  aria-hidden="true"
                  className="flex h-1.5 gap-px overflow-hidden rounded-full"
                  style={{ background: CHART_TRACK }}
                >
                  {sources.map((source, index) => (
                    <m.span
                      key={source.key}
                      className="h-full first:rounded-l-full last:rounded-r-full"
                      style={{
                        background: rankColor(index),
                        flexBasis: 0,
                        minWidth: 3,
                      }}
                      initial={{ flexGrow: 0 }}
                      animate={{ flexGrow: source.count }}
                      transition={{ ...EASE_OUT, duration: 0.5, delay: index * 0.03 }}
                    />
                  ))}
                </div>
                <p className="text-[12px] text-mute">
                  {sources
                    .slice(0, 6)
                    .map(
                      (source) =>
                        `${source.label} ${formatInt(source.count)} (${formatPercent(source.share)})`,
                    )
                    .join(' · ')}
                </p>
              </>
            )}
          </div>
        )}
      </SwapPane>
    </Block>
  )
})
