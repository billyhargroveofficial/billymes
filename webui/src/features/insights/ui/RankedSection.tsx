import { memo, useMemo, useState } from 'react'
import { EmptyHint } from '@/shared/ui/page'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { Notice } from '@/shared/ui/notice'
import { Button } from '@/shared/ui/button'
import { SwapPane } from '@/shared/ui/motion'
import { topWithTail } from '../model/aggregate'
import { BarSeries, type BarRow } from './charts/BarSeries'
import { Block } from './panel'
import { paneFor } from './pane'

export const RankedSection = memo(function RankedSection({
  title,
  rows,
  format,
  ariaLabel,
  emptyText,
  pending,
  error,
  limit = 5,
  colorIndex = 0,
}: {
  title: string
  rows: readonly BarRow[]
  format: (value: number) => string
  ariaLabel: string
  emptyText: string
  pending: boolean
  error: string | null
  limit?: number
  colorIndex?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const { head, hidden } = useMemo(
    () => topWithTail(rows, limit, expanded),
    [expanded, limit, rows],
  )
  const pane = paneFor(pending, error, rows.length === 0)
  const canToggle = pane === 'ready' && (hidden > 0 || expanded)

  return (
    <Block
      title={title}
      actions={
        canToggle ? (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'свернуть' : `все ${rows.length}`}
          </Button>
        ) : null
      }
    >
      <SwapPane pane={pane}>
        {pane === 'skeleton' && <SkeletonRows rows={5} label={`загружаем ${title}`} />}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <EmptyHint>{emptyText}</EmptyHint>}
        {pane === 'ready' && (
          <BarSeries rows={head} format={format} ariaLabel={ariaLabel} colorIndex={colorIndex} />
        )}
      </SwapPane>
    </Block>
  )
})
