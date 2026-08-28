import type { CustomEndpoint, CustomEndpointDraft, ProbeResult } from './types'

export const EMPTY_ENDPOINT_DRAFT: CustomEndpointDraft = {
  id: '',
  name: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  contextLength: '',
  discoverModels: true,
  makeDefault: false,
}

export function draftFromEndpoint(endpoint: CustomEndpoint): CustomEndpointDraft {
  return {
    id: endpoint.id,
    name: endpoint.name,
    baseUrl: endpoint.baseUrl,
    model: endpoint.model,
    apiKey: '',
    contextLength: endpoint.contextLength == null ? '' : String(endpoint.contextLength),
    discoverModels: endpoint.discoverModels,
    makeDefault: endpoint.isCurrent,
  }
}

/** Fields the gateway requires before a save is worth attempting. */
export function endpointDraftError(draft: CustomEndpointDraft): string | null {
  if (!draft.name.trim()) return 'укажи название'
  if (!draft.baseUrl.trim()) return 'укажи адрес эндпоинта'
  if (!/^https?:\/\//i.test(draft.baseUrl.trim()))
    return 'адрес должен начинаться с http:// или https://'
  if (!draft.model.trim()) return 'укажи модель'
  return null
}

export type ProbeVerdict =
  | { kind: 'ok'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'warn'; message: string }

/**
 * Turns `{ok, reachable, message}` into the decision the UI acts on: a bad
 * credential blocks the save, an unreachable probe only warns.
 */
export function probeVerdict(result: ProbeResult, fallback = 'проверка не прошла'): ProbeVerdict {
  if (result.ok) return { kind: 'ok', message: result.message || 'проверка прошла' }
  if (result.reachable) return { kind: 'blocked', message: result.message || fallback }
  return {
    kind: 'warn',
    message: result.message || 'проверить не удалось — сохраняем без проверки',
  }
}
