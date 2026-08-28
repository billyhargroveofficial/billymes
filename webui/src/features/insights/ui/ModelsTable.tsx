import { memo, type ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import { EASE_OUT, m } from '@/shared/ui/motion'
import { formatCompact, formatInt, formatMoney, formatRelativeTime } from '../model/format'
import { modelRowKey, type ModelSortKey, type SortDirection } from '../model/model-rows'
import type { ModelRow } from '../model/types'

type Column = {
  key: ModelSortKey
  label: string
  numeric: boolean
  /** Share of the fixed table layout, so eleven columns fit without a scrollbar. */
  width: string
  cell: (row: ModelRow, nowMs: number, maxCost: number) => ReactNode
}

function capabilityLine(row: ModelRow) {
  const marks: string[] = []
  if (row.capabilities.supportsTools) marks.push('тулы')
  if (row.capabilities.supportsVision) marks.push('зрение')
  if (row.capabilities.supportsReasoning) marks.push('мышление')
  if (row.capabilities.family) marks.push(row.capabilities.family)
  return marks.join(' · ')
}

/** Cost cell with an inline proportional bar behind the figure. */
function costCell(row: ModelRow, _nowMs: number, maxCost: number) {
  const share = maxCost > 0 ? Math.min(100, (row.estimatedCost / maxCost) * 100) : 0
  return (
    <span className="relative inline-flex w-full items-center justify-end">
      {share > 0 && (
        <m.span
          aria-hidden="true"
          className="absolute inset-y-[3px] right-0 origin-right rounded-[3px] bg-mercury/15"
          style={{ width: `${Math.max(4, share)}%` }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ ...EASE_OUT, duration: 0.6, delay: 0.1 }}
        />
      )}
      <span className="relative">{formatMoney(row.estimatedCost)}</span>
    </span>
  )
}

const COLUMNS: readonly Column[] = [
  {
    key: 'model',
    label: 'модель',
    numeric: false,
    width: '17%',
    cell: (row) => (
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-paper">{row.model}</div>
        <div className="truncate text-[10px] text-mute">{capabilityLine(row) || '—'}</div>
      </div>
    ),
  },
  {
    key: 'provider',
    label: 'провайдер',
    numeric: false,
    width: '11%',
    cell: (row) => <span className="font-mono text-[11px] text-mute">{row.provider || '—'}</span>,
  },
  {
    key: 'cost',
    label: 'расход',
    numeric: true,
    width: '9%',
    cell: costCell,
  },
  {
    key: 'calls',
    label: 'вызовы',
    numeric: true,
    width: '7%',
    cell: (row) => formatInt(row.apiCalls),
  },
  {
    key: 'sessions',
    label: 'сессии',
    numeric: true,
    width: '7%',
    cell: (row) => formatInt(row.sessions),
  },
  {
    key: 'input',
    label: 'вход',
    numeric: true,
    width: '8%',
    cell: (row) => formatCompact(row.inputTokens),
  },
  {
    key: 'output',
    label: 'выход',
    numeric: true,
    width: '8%',
    cell: (row) => formatCompact(row.outputTokens),
  },
  {
    key: 'toolCalls',
    label: 'тул-вызовы',
    numeric: true,
    width: '9%',
    cell: (row) => formatInt(row.toolCalls),
  },
  {
    key: 'avg',
    label: 'ср. на сессию',
    numeric: true,
    width: '9%',
    cell: (row) => formatCompact(row.avgTokensPerSession),
  },
  {
    key: 'context',
    label: 'контекст',
    numeric: true,
    width: '8%',
    cell: (row) =>
      row.capabilities.contextWindow ? formatCompact(row.capabilities.contextWindow) : '—',
  },
  {
    key: 'lastUsed',
    label: 'последний раз',
    numeric: true,
    width: '11%',
    cell: (row, nowMs) => formatRelativeTime(row.lastUsedAt, nowMs),
  },
]

export const ModelsTable = memo(function ModelsTable({
  rows,
  sortKey,
  direction,
  onSort,
  nowMs,
}: {
  rows: readonly ModelRow[]
  sortKey: ModelSortKey
  direction: SortDirection
  onSort: (key: ModelSortKey) => void
  nowMs: number
}) {
  const maxCost = rows.reduce((max, row) => Math.max(max, row.estimatedCost), 0)
  return (
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[860px] table-fixed border-collapse text-xs">
        <caption className="sr-only">
          модели профиля за выбранное окно: расход, вызовы, сессии, токены и последнее обращение
        </caption>
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-line bg-raised/40">
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                aria-sort={
                  sortKey === column.key
                    ? direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
                className={cn(
                  'px-2.5 py-2 text-[10px] font-normal uppercase tracking-[0.14em] text-mute',
                  column.numeric ? 'text-right' : 'text-left',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSort(column.key)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-1 transition-colors duration-200 hover:text-paper',
                    sortKey === column.key && 'text-mercury',
                  )}
                >
                  {column.label}
                  <span aria-hidden="true" className="text-[9px]">
                    {sortKey === column.key ? (direction === 'asc' ? '↑' : '↓') : ''}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ModelTableRow key={modelRowKey(row)} row={row} nowMs={nowMs} maxCost={maxCost} />
          ))}
        </tbody>
      </table>
    </div>
  )
})

/**
 * The hover tint is written out rather than reusing the shared
 * `row-interactive` helper: that helper's ::before rail becomes an anonymous
 * table cell on a <tr> and shifts every column one place to the right.
 */
const ModelTableRow = memo(function ModelTableRow({
  row,
  nowMs,
  maxCost,
}: {
  row: ModelRow
  nowMs: number
  maxCost: number
}) {
  return (
    <tr className="border-b border-line/50 transition-colors duration-200 last:border-0 hover:bg-paper/[0.04]">
      {COLUMNS.map((column) => (
        <td
          key={column.key}
          className={cn(
            'px-2.5 py-2 align-middle',
            column.numeric ? 'truncate text-right tabular-nums text-paper' : 'text-left',
          )}
        >
          {column.cell(row, nowMs, maxCost)}
        </td>
      ))}
    </tr>
  )
})
