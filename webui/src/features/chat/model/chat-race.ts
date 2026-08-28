export type SessionOperationToken = {
  operationGeneration: number
  sessionId: string
}

export type CurrentSessionOperation = {
  operationGeneration: number
  sessionId: string | null
}

export type ConfigOperationToken = SessionOperationToken & {
  configGeneration: number
}

export type CurrentConfigOperation = CurrentSessionOperation & {
  configGeneration: number
}

export function canSendChat(draft: string, busy: boolean, historyReady: boolean) {
  return Boolean(draft.trim()) && !busy && historyReady
}

/**
 * `prompt.submit` may have reached the gateway even when its response is
 * lost. Its attachments must leave the composer in that case: retaining them
 * invites the next click to submit the same files twice. Earlier setup RPCs
 * (notably session.create) are not a submitted prompt and remain retryable.
 */
export function submitMayHaveBeenAccepted(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'delivery' in error &&
    'method' in error &&
    error.delivery === 'uncertain' &&
    error.method === 'prompt.submit'
  )
}

/**
 * A fresh session becomes durable inside prompt.submit, not session.create.
 * Start the sidebar refresh after that RPC settles, while keeping refresh
 * failures best-effort and preserving the submit result/error verbatim.
 */
export async function submitThenRefreshSessionCatalog<T>(
  submit: () => Promise<T>,
  refresh: () => Promise<unknown>,
) {
  try {
    return await submit()
  } finally {
    try {
      void refresh().catch(() => undefined)
    } catch {
      // A catalog refresh must never rewrite prompt.submit delivery semantics.
    }
  }
}

export function isCurrentSessionOperation(
  token: SessionOperationToken,
  current: CurrentSessionOperation,
) {
  return (
    token.operationGeneration === current.operationGeneration &&
    token.sessionId === current.sessionId
  )
}

export function isCurrentConfigOperation(
  token: ConfigOperationToken,
  current: CurrentConfigOperation,
) {
  return (
    isCurrentSessionOperation(token, current) && token.configGeneration === current.configGeneration
  )
}
