export type Pane = 'skeleton' | 'error' | 'empty' | 'ready'

/** Single rule for which of the four states a section shows. */
export function paneFor(pending: boolean, error: string | null, empty: boolean): Pane {
  if (pending) return 'skeleton'
  if (error) return 'error'
  if (empty) return 'empty'
  return 'ready'
}
