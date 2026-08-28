/** Shapes returned by the gateway's access-management endpoints. */

export type OauthFlow = 'pkce' | 'device_code' | 'external'

/** `expires_at` arrives either as an ISO string or as epoch milliseconds. */
export type ExpiryValue = string | number | null

export type OauthStatus = {
  loggedIn: boolean
  source: string | null
  sourceLabel: string | null
  tokenPreview: string | null
  expiresAt: ExpiryValue
  hasRefreshToken: boolean
  lastRefresh: string | null
}

export type OauthProvider = {
  id: string
  name: string
  flow: OauthFlow
  cliCommand: string
  docsUrl: string | null
  disconnectHint: string | null
  disconnectCommand: string | null
  disconnectable: boolean
  status: OauthStatus
}

/** Response of `POST /api/providers/oauth/{id}/start`. */
export type OauthSession = {
  sessionId: string
  flow: 'pkce' | 'device_code'
  authUrl: string | null
  userCode: string | null
  verificationUrl: string | null
  expiresIn: number | null
  pollInterval: number | null
}

export type OauthPoll = {
  sessionId: string
  status: string
  errorMessage: string | null
  expiresAt: ExpiryValue
}

export type OauthSubmit = {
  ok: boolean
  status: string | null
  message: string | null
}

export type EnvVar = {
  key: string
  isSet: boolean
  redactedValue: string | null
  description: string
  url: string | null
  category: string
  isPassword: boolean
  tools: string[]
  advanced: boolean
  channelManaged: boolean
  provider: string
  providerLabel: string
  custom: boolean
}

type AccountUsageWindow = {
  label: string
  /** Percent of the window already spent; null when the provider hides it. */
  usedPercent: number | null
  resetAt: string | null
  detail: string | null
}

/** Subscription limits of one connected OAuth account (`/api/providers/account-usage`). */
export type AccountUsage = {
  provider: string
  plan: string | null
  windows: AccountUsageWindow[]
  details: string[]
}

export type PoolEntry = {
  index: number
  id: string
  label: string
  authType: string
  source: string
  priority: number
  lastStatus: string | null
  requestCount: number
  tokenPreview: string | null
  hasRefresh: boolean
}

export type PoolProvider = {
  provider: string
  entries: PoolEntry[]
}

export type CustomEndpoint = {
  id: string
  name: string
  baseUrl: string
  model: string
  models: string[]
  contextLength: number | null
  discoverModels: boolean
  hasApiKey: boolean
  apiKeyPreview: string | null
  isCurrent: boolean
  source: string
}

export type CustomEndpointsPayload = {
  endpoints: CustomEndpoint[]
  current: { provider: string; model: string; baseUrl: string }
}

/** Draft an operator edits in the custom-endpoint form. */
export type CustomEndpointDraft = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  contextLength: string
  discoverModels: boolean
  makeDefault: boolean
}

/**
 * Shared result of the two probe endpoints. `ok=false` with `reachable=true`
 * means the credential was rejected; `reachable=false` means the probe itself
 * could not run, which must not hard-block an offline operator.
 */
export type ProbeResult = {
  ok: boolean
  reachable: boolean
  message: string
  models: string[]
}
