import type { EnvVar, OauthProvider, PoolProvider } from './types'

export function poolEntryCount(providers: readonly PoolProvider[]): number {
  return providers.reduce((total, group) => total + group.entries.length, 0)
}

/**
 * Provider ids worth offering in the "add a key" datalist: whatever already
 * has pooled entries, plus every OAuth-capable provider and every env var that
 * declares a provider slug.
 */
export function poolProviderSuggestions(
  pool: readonly PoolProvider[],
  oauth: readonly OauthProvider[],
  envVars: readonly EnvVar[],
): string[] {
  const ids = new Set<string>()
  for (const group of pool) ids.add(group.provider)
  for (const provider of oauth) ids.add(provider.id)
  for (const item of envVars) if (item.provider) ids.add(item.provider)
  return [...ids].filter(Boolean).sort((a, b) => a.localeCompare(b))
}

export function poolSourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return 'добавлен вручную'
    case 'device_code':
      return 'вход по коду'
    case 'env':
      return 'из .env'
    case 'oauth':
      return 'oauth'
    default:
      return source || 'источник неизвестен'
  }
}
