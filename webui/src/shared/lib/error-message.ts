export function errorMessage(error: unknown, fallback = 'операция не выполнена') {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

type ErrorEntry = readonly [error: unknown, fallback?: string]

export function combinedErrorMessage(...entries: ErrorEntry[]) {
  const messages = entries.flatMap(([error, fallback]) =>
    error == null ? [] : [errorMessage(error, fallback)],
  )
  return [...new Set(messages)].join(' · ') || null
}
