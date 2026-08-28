export type ProfileMeta = {
  name: string
  label: string
  kicker: string
  from: string
  to: string
}

const PROFILE_META: Record<string, ProfileMeta> = {
  default: {
    name: 'default',
    label: 'Hermes',
    kicker: 'главный стол',
    from: '#6B8CFF',
    to: '#D7C4A3',
  },
  api: {
    name: 'api',
    label: 'API',
    kicker: 'шлюз',
    from: '#8B93A7',
    to: '#6B8CFF',
  },
}

export function metaFor(name: string): ProfileMeta {
  return (
    PROFILE_META[name] ?? {
      name,
      label: name,
      kicker: 'профиль',
      from: '#6B8CFF',
      to: '#D7C4A3',
    }
  )
}
