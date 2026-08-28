import { memo, useMemo } from 'react'
import { Notice } from '@/shared/ui/notice'
import { SwapPane } from '@/shared/ui/motion'
import { formatBytes, formatDuration, formatPercent } from '../model/format'
import type { SystemStats } from '../model/types'
import { Block } from './panel'
import { paneFor } from './pane'

function line(stats: SystemStats): string {
  const parts: string[] = []
  if (stats.hostname) parts.push(stats.hostname)
  const os = [stats.os, stats.arch].filter(Boolean).join(' ')
  if (os) parts.push(os)
  if (stats.hermesVersion) parts.push(`hermes ${stats.hermesVersion}`)
  if (stats.cpuPercent != null) parts.push(`cpu ${formatPercent(stats.cpuPercent, 0)}`)
  if (stats.memory) parts.push(`память ${formatPercent(stats.memory.percent, 0)}`)
  if (stats.disk) parts.push(`диск ${formatPercent(stats.disk.percent, 0)}`)
  if (stats.uptimeSeconds != null) parts.push(formatDuration(stats.uptimeSeconds))
  if (stats.processRss != null) parts.push(formatBytes(stats.processRss))
  return parts.join(' · ')
}

export const HostSection = memo(function HostSection({
  stats,
  pending,
  error,
}: {
  stats: SystemStats | null
  pending: boolean
  error: string | null
}) {
  const text = useMemo(() => (stats ? line(stats) : ''), [stats])
  const pane = paneFor(pending, error, !text)

  return (
    <Block title="хост">
      <SwapPane pane={pane}>
        {pane === 'skeleton' && <p className="text-sm text-mute">загружаем хост</p>}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <p className="text-sm text-mute">хост не отвечает</p>}
        {pane === 'ready' && <p className="truncate font-mono text-[12px] text-paper">{text}</p>}
      </SwapPane>
    </Block>
  )
})
