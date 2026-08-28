import { describe, expect, it } from 'vitest'
import { createRuntimeRegistry, type GatewayRuntime } from './gateway-runtime.ts'

const defaults: GatewayRuntime = {
  origin: 'http://gateway.test',
  host: 'gateway.test',
  token: '',
}

describe('runtime registry leases', () => {
  it('makes control lease release idempotent', () => {
    const registry = createRuntimeRegistry(defaults, 1, 1)
    const first = registry.reserveControl('runtime-client-lease')
    const second = registry.reserveControl('runtime-client-lease')

    registry.releasePending(first)
    registry.releasePending(first)

    expect(second.entry.pendingControls).toBe(1)
    expect(second.entry.lastUsedAt).toBeGreaterThan(0)
    registry.releasePending(second)
    expect(second.entry.pendingControls).toBe(0)
  })

  it('does not evict a live websocket runtime after its TTL', async () => {
    const registry = createRuntimeRegistry(defaults, 1, 1)
    const socket = registry.reserveWebSocket('runtime-client-socket')
    await new Promise((resolve) => setTimeout(resolve, 5))
    registry.cleanup()

    expect(() => registry.get('runtime-client-other')).toThrow('registry is busy')

    registry.releaseWebSocket(socket)
    expect(() => registry.get('runtime-client-other')).not.toThrow()
  })
})
