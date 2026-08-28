export const modelKeys = {
  all: ['models'] as const,
  options: (profile?: string) => ['models', 'options', profile ?? 'default'] as const,
  info: (profile?: string) => ['models', 'info', profile ?? 'default'] as const,
  auxiliary: (profile?: string) => ['models', 'auxiliary', profile ?? 'default'] as const,
}
