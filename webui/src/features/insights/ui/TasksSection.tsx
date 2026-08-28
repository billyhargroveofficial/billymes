import { memo, useMemo } from 'react'
import { Notice } from '@/shared/ui/notice'
import { SwapPane } from '@/shared/ui/motion'
import { rankBy } from '../model/aggregate'
import { formatInt, formatMoney } from '../model/format'
import type { TaskUsage } from '../model/types'
import { Block } from './panel'
import { paneFor } from './pane'

export const TasksSection = memo(function TasksSection({
  tasks,
  pending,
  error,
}: {
  tasks: readonly TaskUsage[]
  pending: boolean
  error: string | null
}) {
  const ordered = useMemo(
    () => rankBy(tasks, (task) => task.estimatedCost || task.apiCalls),
    [tasks],
  )
  const pane = paneFor(pending, error, tasks.length === 0)

  return (
    <Block title="задачи">
      <SwapPane pane={pane}>
        {pane === 'skeleton' && <p className="text-sm text-mute">загружаем задачи</p>}
        {pane === 'error' && <Notice>{error}</Notice>}
        {pane === 'empty' && <p className="text-sm text-mute">вспомогательных задач не было</p>}
        {pane === 'ready' && (
          <ul className="m-0 list-none space-y-1.5 p-0">
            {ordered.map((task) => (
              <li key={task.task} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-[12px] text-paper">
                  {task.task}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-mute">
                  {formatInt(task.apiCalls)} · {formatMoney(task.estimatedCost)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SwapPane>
    </Block>
  )
})
