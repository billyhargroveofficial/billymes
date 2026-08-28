import { createContext } from 'react'
import type { Profile, StatusPayload } from './types'

export type ProfileContextValue = {
  profile: string
  setProfile: (name: string) => void
  profiles: Profile[]
  profilesLoading: boolean
  status?: StatusPayload
  loadError: string | null
}

export const ProfileContext = createContext<ProfileContextValue | null>(null)
