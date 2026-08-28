import type { ModelCapability, ModelOption, ProviderOption } from './types'

export function modelList(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return models
    .map((item) =>
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item as ModelOption).id
          : undefined,
    )
    .filter((id): id is string => Boolean(id))
}

export function modelCapabilityFor(
  providers: ProviderOption[],
  provider: string,
  model: string,
): ModelCapability | null {
  const selectedProvider = providers.find((item) => item.slug === provider)
  if (!selectedProvider) return null

  const declared = selectedProvider.capabilities?.[model]
  if (declared) return declared

  const descriptor = selectedProvider.models.find(
    (item): item is ModelOption => typeof item !== 'string' && item.id === model,
  )
  if (descriptor?.supports_reasoning === undefined) return null
  return { fast: false, reasoning: descriptor.supports_reasoning }
}
