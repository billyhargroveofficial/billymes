/** Query keys for every access-management surface, in one place. */
export const providerKeys = {
  oauth: (profile: string) => ['providers-oauth', profile] as const,
  accountUsage: (profile: string) => ['providers-account-usage', profile] as const,
  oauthPoll: (profile: string, providerId: string, sessionId: string) =>
    ['providers-oauth-poll', profile, providerId, sessionId] as const,
  env: (profile: string) => ['providers-env', profile] as const,
  pool: () => ['providers-pool'] as const,
  endpoints: (profile: string) => ['providers-endpoints', profile] as const,
}
