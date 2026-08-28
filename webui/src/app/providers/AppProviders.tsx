import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ChatRuntimeProvider } from '@/features/chat'
import { GatewayProvider } from '@/features/gateway'
import { ProfileProvider } from '@/features/profiles'
import { ThemeProvider } from '@/shared/theme'
import { MotionProvider } from '@/shared/ui/motion'
import { queryClient } from './query-client'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MotionProvider>
          <GatewayProvider>
            <ProfileProvider>
              <ChatRuntimeProvider>{children}</ChatRuntimeProvider>
            </ProfileProvider>
          </GatewayProvider>
        </MotionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
