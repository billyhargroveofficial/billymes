import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { profileApi } from '../api/profile-api'
import { combinedErrorMessage } from '@/shared/lib/error-message'
import { ProfileContext, type ProfileContextValue } from './profile-context'
import { persistProfile, readStoredProfile } from './profile-storage'
import type { Profile } from './types'

function visibleProfiles(list: Profile[]) {
  return list.filter((p) => p.name !== 'api' || p.gateway_running)
}

const EMPTY_PROFILES: Profile[] = []

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [requestedProfile, setProfileState] = useState(readStoredProfile)
  const setProfile = useCallback((name: string) => {
    setProfileState(name)
    persistProfile(name)
  }, [])
  const profilesQ = useQuery({ queryKey: ['profiles'], queryFn: profileApi.profiles })
  const statusQ = useQuery({
    queryKey: ['status'],
    queryFn: profileApi.status,
    refetchInterval: 15_000,
  })
  const profiles = useMemo(
    () => visibleProfiles(profilesQ.data?.profiles ?? EMPTY_PROFILES),
    [profilesQ.data],
  )
  const profile = profiles.some((item) => item.name === requestedProfile)
    ? requestedProfile
    : (profiles.find((item) => item.is_default)?.name ?? profiles[0]?.name ?? requestedProfile)

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      setProfile,
      profiles,
      profilesLoading: profilesQ.isPending,
      ...(statusQ.data ? { status: statusQ.data } : {}),
      loadError: combinedErrorMessage(
        [profilesQ.error, 'не удалось загрузить профили'],
        [statusQ.error, 'не удалось загрузить статус гейтвея'],
      ),
    }),
    [
      profile,
      profiles,
      profilesQ.isPending,
      profilesQ.error,
      setProfile,
      statusQ.data,
      statusQ.error,
    ],
  )
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
}
