import { useContext } from 'react'
import { GatewayContext } from './gateway-context'

export function useGateway() {
  const context = useContext(GatewayContext)
  if (!context) throw new Error('useGateway outside GatewayProvider')
  return context
}
