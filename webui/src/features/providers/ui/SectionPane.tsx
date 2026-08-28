import type { ReactNode } from 'react'
import { EmptyHint } from '@/shared/ui/page'
import { SwapPane } from '@/shared/ui/motion'
import { Notice } from '@/shared/ui/notice'
import type { PaneState } from '../model/pane-state'

/** Cross-fades one section between its skeleton, error, empty and ready view. */
export function SectionPane({
  state,
  skeleton,
  error,
  empty,
  children,
}: {
  state: PaneState
  skeleton: ReactNode
  error: string | null
  empty: string
  children: ReactNode
}) {
  return (
    <SwapPane pane={state}>
      {state === 'skeleton' ? (
        skeleton
      ) : state === 'error' ? (
        <Notice>{error ?? 'не удалось загрузить данные'}</Notice>
      ) : state === 'empty' ? (
        <EmptyHint>{empty}</EmptyHint>
      ) : (
        children
      )}
    </SwapPane>
  )
}
