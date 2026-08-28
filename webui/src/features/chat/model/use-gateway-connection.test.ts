import { describe, expect, it } from 'vitest'
import { reconnectDelay } from './use-gateway-connection'

describe('reconnectDelay', () => {
  it('backs off exponentially and remains capped', () => {
    expect([0, 1, 2, 3].map(reconnectDelay)).toEqual([400, 800, 1_600, 3_200])
    expect(reconnectDelay(20)).toBe(15_000)
    expect(reconnectDelay(-3)).toBe(400)
  })
})
