import { createContext } from 'react'
import type { GatewayRuntimeInfo, GatewaySettings } from './gateway-settings'

export type GatewayContextValue = {
  settings: GatewaySettings
  runtime: GatewayRuntimeInfo | null
  epoch: number
  ready: boolean
  error: string | null
  apply: (next: GatewaySettings) => Promise<void>
}

export const GatewayContext = createContext<GatewayContextValue | null>(null)
