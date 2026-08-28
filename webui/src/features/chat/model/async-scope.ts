/**
 * Reject async completions that outlive the profile/session UI scope which
 * started them. A generation is necessary in addition to comparing the
 * current values: switching A → B → A must not revive A's first request.
 */
export type AsyncScope = {
  profile: string
  scopeKey: string
}

export type AsyncScopeSnapshot = AsyncScope & {
  generation: number
}

export function createAsyncScopeGuard(initial: AsyncScope) {
  let current = initial
  let generation = 0

  return {
    setScope(next: AsyncScope) {
      if (next.profile === current.profile && next.scopeKey === current.scopeKey) return
      current = next
      generation += 1
    },
    capture(): AsyncScopeSnapshot {
      return { ...current, generation }
    },
    isCurrent(snapshot: AsyncScopeSnapshot) {
      return (
        snapshot.generation === generation &&
        snapshot.profile === current.profile &&
        snapshot.scopeKey === current.scopeKey
      )
    },
    /** Permanently reject work owned by an unmounted UI scope. */
    invalidate() {
      generation += 1
    },
  }
}
