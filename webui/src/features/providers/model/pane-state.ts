/** The four states every async surface on this page cross-fades between. */
export type PaneState = 'skeleton' | 'error' | 'empty' | 'ready'

export function paneState(input: { pending: boolean; error: unknown; empty: boolean }): PaneState {
  if (input.pending) return 'skeleton'
  if (input.error != null) return 'error'
  if (input.empty) return 'empty'
  return 'ready'
}
