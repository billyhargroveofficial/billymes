import { expectRecord, expectString, requestJson, withProfile } from '@/shared/api'
import type {
  AccountUsage,
  CustomEndpointDraft,
  CustomEndpointsPayload,
  EnvVar,
  OauthPoll,
  OauthProvider,
  OauthSession,
  OauthSubmit,
  PoolProvider,
  ProbeResult,
} from '../model/types'
import {
  parseAccountUsage,
  parseCustomEndpoints,
  parseEnvVars,
  parseOauthPoll,
  parseOauthProviders,
  parseOauthSession,
  parseOauthSubmit,
  parsePool,
  parseProbe,
} from './providers-parsers'

/** Body accepted by both custom-endpoint write endpoints. */
function endpointBody(draft: CustomEndpointDraft) {
  const context = Number.parseInt(draft.contextLength, 10)
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    base_url: draft.baseUrl.trim(),
    model: draft.model.trim(),
    ...(draft.apiKey ? { api_key: draft.apiKey } : {}),
    ...(Number.isFinite(context) ? { context_length: context } : {}),
    discover_models: draft.discoverModels,
    make_default: draft.makeDefault,
  }
}

const id = (value: string) => encodeURIComponent(value)

export const providersApi = {
  oauthProviders: async (profile?: string): Promise<OauthProvider[]> =>
    parseOauthProviders(await requestJson(withProfile('/api/providers/oauth', profile))),

  accountUsage: async (profile?: string): Promise<AccountUsage[]> =>
    parseAccountUsage(await requestJson(withProfile('/api/providers/account-usage', profile))),

  startOauth: async (providerId: string, profile?: string): Promise<OauthSession> =>
    parseOauthSession(
      await requestJson(withProfile(`/api/providers/oauth/${id(providerId)}/start`, profile), {
        method: 'POST',
      }),
    ),

  pollOauth: async (providerId: string, sessionId: string, profile?: string): Promise<OauthPoll> =>
    parseOauthPoll(
      await requestJson(
        withProfile(`/api/providers/oauth/${id(providerId)}/poll/${id(sessionId)}`, profile),
      ),
    ),

  submitOauthCode: async (
    providerId: string,
    sessionId: string,
    code: string,
    profile?: string,
  ): Promise<OauthSubmit> =>
    parseOauthSubmit(
      await requestJson(withProfile(`/api/providers/oauth/${id(providerId)}/submit`, profile), {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, code }),
      }),
    ),

  disconnectOauth: (providerId: string, profile?: string) =>
    requestJson(withProfile(`/api/providers/oauth/${id(providerId)}`, profile), {
      method: 'DELETE',
    }),

  cancelOauthSession: (sessionId: string, profile?: string) =>
    requestJson(withProfile(`/api/providers/oauth/sessions/${id(sessionId)}`, profile), {
      method: 'DELETE',
    }),

  envVars: async (profile?: string): Promise<EnvVar[]> =>
    parseEnvVars(await requestJson(withProfile('/api/env', profile))),

  setEnvVar: (key: string, value: string, profile?: string) =>
    requestJson(withProfile('/api/env', profile), {
      method: 'PUT',
      body: JSON.stringify({ key, value, profile }),
    }),

  removeEnvVar: (key: string, profile?: string) =>
    requestJson(withProfile('/api/env', profile), {
      method: 'DELETE',
      body: JSON.stringify({ key, profile }),
    }),

  /**
   * Rate-limited to five calls per 30 s and audit-logged upstream. Only ever
   * call this from an explicit per-key operator action.
   */
  revealEnvVar: async (key: string, profile?: string): Promise<string> => {
    const payload = expectRecord(
      await requestJson(withProfile('/api/env/reveal', profile), {
        method: 'POST',
        body: JSON.stringify({ key, profile }),
      }),
      'env reveal',
    )
    return expectString(payload.value, 'env reveal.value')
  },

  validateCredential: async (key: string, value: string, profile?: string): Promise<ProbeResult> =>
    parseProbe(
      await requestJson('/api/providers/validate', {
        method: 'POST',
        body: JSON.stringify({ key, value, profile }),
      }),
      'credential probe',
    ),

  credentialPool: async (): Promise<PoolProvider[]> =>
    parsePool(await requestJson('/api/credentials/pool')),

  addPoolEntry: (provider: string, apiKey: string, label: string) =>
    requestJson('/api/credentials/pool', {
      method: 'POST',
      body: JSON.stringify({
        provider,
        api_key: apiKey,
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    }),

  removePoolEntry: (provider: string, index: number) =>
    requestJson(`/api/credentials/pool/${id(provider)}/${index}`, { method: 'DELETE' }),

  customEndpoints: async (profile?: string): Promise<CustomEndpointsPayload> =>
    parseCustomEndpoints(
      await requestJson(withProfile('/api/providers/custom-endpoints', profile)),
    ),

  saveCustomEndpoint: (draft: CustomEndpointDraft, profile?: string) =>
    requestJson(withProfile('/api/providers/custom-endpoints', profile), {
      method: 'POST',
      body: JSON.stringify(endpointBody(draft)),
    }),

  validateCustomEndpoint: async (draft: CustomEndpointDraft): Promise<ProbeResult> =>
    parseProbe(
      await requestJson('/api/providers/custom-endpoints/validate', {
        method: 'POST',
        body: JSON.stringify(endpointBody(draft)),
      }),
      'endpoint probe',
    ),

  activateCustomEndpoint: (endpointId: string, profile?: string) =>
    requestJson(
      withProfile(`/api/providers/custom-endpoints/${id(endpointId)}/activate`, profile),
      { method: 'POST' },
    ),

  deleteCustomEndpoint: (endpointId: string, profile?: string) =>
    requestJson(withProfile(`/api/providers/custom-endpoints/${id(endpointId)}`, profile), {
      method: 'DELETE',
    }),
}
