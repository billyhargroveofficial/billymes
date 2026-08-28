import { useContext } from 'react'
import { ChatRuntimeContext } from './chat-runtime-context'

export function useChatRuntime() {
  const context = useContext(ChatRuntimeContext)
  if (!context) throw new Error('useChatRuntime outside ChatRuntimeProvider')
  return context
}
