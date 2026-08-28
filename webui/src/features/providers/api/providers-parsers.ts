import { expectArray, expectRecord, expectString } from '@/shared/api'
import type {
  AccountUsage,
  CustomEndpoint,
  CustomEndpointsPayload,
  EnvVar,
  ExpiryValue,
  OauthFlow,
  OauthPoll,
  OauthProvider,
  OauthSession,
  OauthStatus,
  OauthSubmit,
  PoolEntry,
  PoolProvider,
  ProbeResult,
} from '../model/types'

const FLOWS: readonly OauthFlow[] = ['pkce', 'device_code', 'external']

function bool(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function num(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Empty strings are "absent" everywhere in this payload family. */
function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strings(value: unknown, label: string): string[] {
  return expectArray(value ?? [], label).flatMap((item) =>
    typeof item === 'string' && item !== '' ? [item] : [],
  )
}

/** The gateway returns ISO strings for some providers and epoch ms for others. */
function expiry(value: unknown): ExpiryValue {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function flowOf(value: unknown, label: string): OauthFlow {
  const raw = text(value)
  const match = FLOWS.find((flow) => flow === raw)
  if (!match) throw new Error(`${label}: unknown OAuth flow "${raw}"`)
  return match
}

function parseOauthStatus(value: unknown, label: string): OauthStatus {
  const row = expectRecord(value ?? {}, label)
  return {
    loggedIn: bool(row.logged_in),
    source: nullableText(row.source),
    sourceLabel: nullableText(row.source_label),
    tokenPreview: nullableText(row.token_preview),
    expiresAt: expiry(row.expires_at),
    hasRefreshToken: bool(row.has_refresh_token),
    lastRefresh: nullableText(row.last_refresh),
  }
}

export function parseOauthProviders(value: unknown): OauthProvider[] {
  const payload = expectRecord(value, 'oauth providers')
  return expectArray(payload.providers, 'oauth providers.providers').map((item, index) => {
    const label = `oauth providers.providers[${index}]`
    const row = expectRecord(item, label)
    return {
      id: expectString(row.id, `${label}.id`),
      name: text(row.name) || expectString(row.id, `${label}.id`),
      flow: flowOf(row.flow, label),
      cliCommand: text(row.cli_command),
      docsUrl: nullableText(row.docs_url),
      disconnectHint: nullableText(row.disconnect_hint),
      disconnectCommand: nullableText(row.disconnect_command),
      disconnectable: bool(row.disconnectable),
      status: parseOauthStatus(row.status, `${label}.status`),
    }
  })
}

export function parseOauthSession(value: unknown): OauthSession {
  const row = expectRecord(value, 'oauth session')
  const flow = text(row.flow) === 'pkce' ? 'pkce' : 'device_code'
  return {
    sessionId: expectString(row.session_id, 'oauth session.session_id'),
    flow,
    authUrl: nullableText(row.auth_url),
    userCode: nullableText(row.user_code),
    verificationUrl: nullableText(row.verification_url),
    expiresIn: optionalCount(row.expires_in),
    pollInterval: optionalCount(row.poll_interval),
  }
}

export function parseOauthPoll(value: unknown): OauthPoll {
  const row = expectRecord(value, 'oauth poll')
  return {
    sessionId: text(row.session_id),
    status: text(row.status, 'pending'),
    errorMessage: nullableText(row.error_message),
    expiresAt: expiry(row.expires_at),
  }
}

export function parseOauthSubmit(value: unknown): OauthSubmit {
  const row = expectRecord(value, 'oauth submit')
  return {
    ok: bool(row.ok),
    status: nullableText(row.status),
    message: nullableText(row.message),
  }
}

/** `GET /api/env` answers with a map of key -> descriptor, not a list. */
export function parseEnvVars(value: unknown): EnvVar[] {
  const payload = expectRecord(value, 'env vars')
  return Object.entries(payload).map(([key, item]) => {
    const label = `env vars.${key}`
    const row = expectRecord(item, label)
    return {
      key,
      isSet: bool(row.is_set),
      redactedValue: nullableText(row.redacted_value),
      description: text(row.description),
      url: nullableText(row.url),
      category: text(row.category, 'other'),
      isPassword: bool(row.is_password),
      tools: strings(row.tools, `${label}.tools`),
      advanced: bool(row.advanced),
      channelManaged: bool(row.channel_managed),
      provider: text(row.provider),
      providerLabel: text(row.provider_label),
      custom: bool(row.custom),
    }
  })
}

function parsePoolEntry(value: unknown, label: string, fallbackIndex: number): PoolEntry {
  const row = expectRecord(value, label)
  return {
    index: num(row.index, fallbackIndex),
    id: text(row.id),
    label: text(row.label),
    authType: text(row.auth_type),
    source: text(row.source),
    priority: num(row.priority),
    lastStatus: nullableText(row.last_status),
    requestCount: num(row.request_count),
    tokenPreview: nullableText(row.token_preview),
    hasRefresh: bool(row.has_refresh),
  }
}

export function parsePool(value: unknown): PoolProvider[] {
  const payload = expectRecord(value, 'credential pool')
  return expectArray(payload.providers, 'credential pool.providers').map((item, index) => {
    const label = `credential pool.providers[${index}]`
    const row = expectRecord(item, label)
    return {
      provider: expectString(row.provider, `${label}.provider`),
      entries: expectArray(row.entries ?? [], `${label}.entries`).map((entry, entryIndex) =>
        parsePoolEntry(entry, `${label}.entries[${entryIndex}]`, entryIndex + 1),
      ),
    }
  })
}

export function parseAccountUsage(value: unknown): AccountUsage[] {
  const payload = expectRecord(value, 'account usage')
  return expectArray(payload.accounts ?? [], 'account usage.accounts').map((item, index) => {
    const label = `account usage.accounts[${index}]`
    const row = expectRecord(item, label)
    return {
      provider: expectString(row.provider, `${label}.provider`),
      plan: nullableText(row.plan),
      windows: expectArray(row.windows ?? [], `${label}.windows`).map((window, windowIndex) => {
        const windowLabel = `${label}.windows[${windowIndex}]`
        const record = expectRecord(window, windowLabel)
        return {
          label: text(record.label),
          usedPercent: optionalCount(record.used_percent),
          resetAt: nullableText(record.reset_at),
          detail: nullableText(record.detail),
        }
      }),
      details: strings(row.details, `${label}.details`),
    }
  })
}

function parseEndpoint(value: unknown, label: string): CustomEndpoint {
  const row = expectRecord(value, label)
  return {
    id: expectString(row.id, `${label}.id`),
    name: text(row.name) || expectString(row.id, `${label}.id`),
    baseUrl: text(row.base_url),
    model: text(row.model),
    models: strings(row.models, `${label}.models`),
    contextLength: optionalCount(row.context_length),
    discoverModels: bool(row.discover_models, true),
    hasApiKey: bool(row.has_api_key),
    apiKeyPreview: nullableText(row.api_key_preview),
    isCurrent: bool(row.is_current),
    source: text(row.source),
  }
}

export function parseCustomEndpoints(value: unknown): CustomEndpointsPayload {
  const payload = expectRecord(value, 'custom endpoints')
  const current = expectRecord(payload.current ?? {}, 'custom endpoints.current')
  return {
    endpoints: expectArray(payload.endpoints ?? [], 'custom endpoints.endpoints').map(
      (item, index) => parseEndpoint(item, `custom endpoints.endpoints[${index}]`),
    ),
    current: {
      provider: text(current.provider),
      model: text(current.model),
      baseUrl: text(current.base_url),
    },
  }
}

export function parseProbe(value: unknown, label: string): ProbeResult {
  const row = expectRecord(value, label)
  return {
    ok: bool(row.ok),
    reachable: bool(row.reachable, true),
    message: text(row.message),
    models: strings(row.models, `${label}.models`),
  }
}
