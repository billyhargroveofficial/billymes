import { useContext } from 'react'
import { ProfileContext } from './profile-context'

export function useProfileScope() {
  const context = useContext(ProfileContext)
  if (!context) throw new Error('useProfileScope outside ProfileProvider')
  return context
}
