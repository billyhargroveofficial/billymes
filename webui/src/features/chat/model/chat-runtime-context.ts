import { createContext } from 'react'
import type { ConnectionState } from '@/features/gateway'
import type { ChatMessage, SessionInfo, SessionRuntime } from './types'

export type ChatRuntimeContextValue = {
  sessionId: string | null
  historySessionId: string | null
  messages: ChatMessage[]
  draft: string
  setDraft: (value: string) => void
  busy: boolean
  connectionState: ConnectionState
  historyReady: boolean
  loadError: string | null
  runtime: SessionRuntime
  reasoningSupported: boolean
  sessions: SessionInfo[]
  sessionsLoading: boolean
  openSession: (id: string) => Promise<void>
  /** Loads the preceding persisted history page and returns the added row count. */
  loadEarlierMessages: () => Promise<number>
  hasEarlierMessages: boolean
  loadingEarlierMessages: boolean
  /** False means no request was accepted (e.g. double-click or disconnected). */
  send: (attachmentMarkers?: string[]) => Promise<boolean>
  stop: () => Promise<void>
  newChat: () => void
  setDialogModel: (provider: string, model: string) => Promise<void>
  setDialogReasoning: (level: string) => Promise<void>
}

export const ChatRuntimeContext = createContext<ChatRuntimeContextValue | null>(null)
