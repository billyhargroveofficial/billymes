import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { GatewayClient, type ConnectionState, type GatewayEvent } from '@/features/gateway'
import { chatApi } from '../api/chat-api'

const RETRY_MAX_MS = 15_000

export function reconnectDelay(attempt: number) {
  return Math.min(RETRY_MAX_MS, 400 * 2 ** Math.min(Math.max(0, attempt), 6))
}

export function useGatewayConnection({
  epoch,
  onEvent,
  onState,
}: {
  epoch: number
  onEvent: (event: GatewayEvent) => void
  onState: (state: ConnectionState) => void
}) {
  const clientRef = useRef<GatewayClient | null>(null)
  const [state, setState] = useState<ConnectionState>('idle')
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  const emitEvent = useEffectEvent(onEvent)
  const emitState = useEffectEvent(onState)

  useEffect(() => {
    let disposed = false
    let connecting = false
    let retryTimer: number | null = null
    let attempt = 0
    const client = new GatewayClient()
    clientRef.current = client

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== null) return
      const delay = reconnectDelay(attempt)
      attempt += 1
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        void connect()
      }, delay)
    }

    const connect = async () => {
      if (disposed || connecting) return
      connecting = true
      try {
        const ticket = await chatApi.wsTicket()
        if (disposed) return
        await client.connect(ticket)
        if (!disposed) setConnectionGeneration((generation) => generation + 1)
        attempt = 0
      } catch {
        if (!disposed) {
          scheduleReconnect()
        }
      } finally {
        connecting = false
      }
    }

    const offEvent = client.onEvent((event) => emitEvent(event))
    const offState = client.onState((next) => {
      if (disposed) return
      setState(next)
      emitState(next)
      if ((next === 'closed' || next === 'error') && !connecting) scheduleReconnect()
    })

    void connect()
    return () => {
      disposed = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      offEvent()
      offState()
      if (clientRef.current === client) clientRef.current = null
      client.close()
    }
  }, [epoch])

  const request = useCallback(
    (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
      const client = clientRef.current
      if (!client) return Promise.reject(new Error('gateway not connected'))
      return client.request(method, params, timeoutMs)
    },
    [],
  )

  return { state, request, connectionGeneration }
}
