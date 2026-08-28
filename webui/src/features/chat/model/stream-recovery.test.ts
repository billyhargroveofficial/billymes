import { describe, expect, it } from 'vitest'
import { acceptGatewayEvent, replayEpochChanged } from './stream-recovery'

describe('stream replay watermarks', () => {
  it('applies a sequence exactly once across live and replay delivery', () => {
    const marks = new Map<string, number>()
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 4 })).toBe(
      true,
    )
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 4 })).toBe(
      false,
    )
    expect(acceptGatewayEvent(marks, { type: 'message.delta', session_id: 'live', seq: 5 })).toBe(
      true,
    )
  })

  it('requires a history fallback when a known replay epoch changes', () => {
    expect(replayEpochChanged('gateway-a', 'gateway-b')).toBe(true)
    expect(replayEpochChanged(null, 'gateway-b')).toBe(false)
  })
})
