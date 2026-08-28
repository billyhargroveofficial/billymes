import { memo, useCallback, useMemo, useState } from 'react'
import { EmptyHint } from '@/shared/ui/page'
import { SkeletonRows } from '@/shared/ui/skeleton'
import { Notice } from '@/shared/ui/notice'
import { Button } from '@/shared/ui/button'
import { SwapPane } from '@/shared/ui/motion'
import { rankBy } from '../model/aggregate'
import { formatInt, formatMoney, formatPercent } from '../model/format'
import { modelRowKey, sortModelRows } from '../model/model-rows'
import type { ModelSortKey, SortDirection } from '../model/model-rows'
import type { ModelRow } from '../model/types'
import { BarSeries, type BarRow } from './charts/BarSeries'
import { ModelsTable } from './ModelsTable'
import { Block } from './panel'
import { paneFor } from './pane'

const BAR_LIMIT = 5
const TEXT_KEYS: readonly ModelSortKey[] = ['model', 'provider']

export const ModelsSection = memo(function ModelsSection({
  rows,
  pending,
  error,
  nowMs,
}: {
  rows: readonly ModelRow[]
  pending: boolean
  error: string | null
  nowMs: number
}) {
  const [sortKey, setSortKey] = useState<ModelSortKey>('cost')
  const [direction, setDirection] = useState<SortDirection>('desc')
  const [tableOpen, setTableOpen] = useState(false)

  const totalCost = useMemo(() => rows.reduce((sum, row) => sum + row.estimatedCost, 0), [rows])

  const bars = useMemo<BarRow[]>(
    () =>
      rankBy(rows, (row) => row.estimatedCost)
        .slice(0, BAR_LIMIT)
        .map((row) => ({
          key: modelRowKey(row),
          label: row.model,
          value: row.estimatedCost,
          ...(row.provider ? { hint: row.provider } : {}),
          ...(totalCost > 0 ? { share: formatPercent((row.estimatedCost / totalCost) * 100) } : {}),
        })),
    [rows, totalCost],
  )

  const onSort = useCallback(
    (key: ModelSortKey) => {
      if (key === sortKey) {
        setDirection((value) => (value === 'asc' ? 'desc' : 'asc'))
        return
      }
      setSortKey(key)
      setDirection(TEXT_KEYS.includes(key) ? 'asc' : 'desc')
    },
    [sortKey],
  )

  const pane = paneFor(pending, error, rows.length === 0)
  const sorted = useMemo(() => sortModelRows(rows, sortKey, direction), [direction, rows, sortKey])

  return (
    <Block
      title="модели"
      actions={
        pane === 'ready' && sorted.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setTableOpen((value) => !value)}>
            {tableOpen ? 'свернуть' : `все ${formatInt(sorted.length)}`}
          </Button>
        ) : null
      }
    >
      <SwapPane pane={pane}>
        {pane === 'skeleton' && <SkeletonRows rows={5} label="загружаем модели" />}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <EmptyHint>модели не вызывались</EmptyHint>}
        {pane === 'ready' && (
          <div className="space-y-4">
            {bars.length ? (
              <BarSeries
                rows={bars}
                format={formatMoney}
                colorIndex={0}
                ariaLabel="модели, ранжированные по оценочному расходу"
              />
            ) : (
              <EmptyHint>расход по моделям не считался</EmptyHint>
            )}
            {tableOpen && (
              <ModelsTable
                rows={sorted}
                sortKey={sortKey}
                direction={direction}
                onSort={onSort}
                nowMs={nowMs}
              />
            )}
          </div>
        )}
      </SwapPane>
    </Block>
  )
})
