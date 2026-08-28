import type { SessionPresentationCard } from './rpc-contracts'
import type { ChatMessage, ToolCall } from './types'

/** Server-side hosted calls have no transcript rows; make them first-class activity cards. */
function mergePresentationTools(
  previous: readonly ToolCall[],
  cards: readonly SessionPresentationCard[],
): ToolCall[] {
  const byId = new Map(previous.map((tool) => [tool.id, tool]))
  for (const card of cards) {
    byId.set(card.id, {
      id: card.id,
      name: card.name,
      args: card.args,
      result: '',
      ...(card.preview ? { preview: card.preview } : {}),
      status:
        card.status === 'running'
          ? 'running'
          : card.status === 'error' || card.ok === false
            ? 'error'
            : 'done',
      duration: card.duration_s,
    })
  }
  const order = new Map(cards.map((card) => [card.id, card.sequence]))
  return [...byId.values()].sort(
    (left, right) =>
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
  )
}

/** Attach durable hosted cards to the UI segment for their own turn. This is
 * UI-only state: no synthetic row is sent back to the transcript API. */
export function mergePresentationIntoMessages(
  messages: readonly ChatMessage[],
  cards: readonly SessionPresentationCard[],
  userTurnOffset = 0,
) {
  const next = messages.map((message) => ({ ...message, tools: [...message.tools] }))
  const unattached: SessionPresentationCard[] = []
  const cardIds = new Set(cards.map((card) => card.id))
  // A reconnect can return durable copies of cards first seen live. Remove
  // the whole returned batch before reattaching it, otherwise a one-by-one
  // merge makes each later card sort ahead of all earlier cards.
  for (const message of next) {
    message.tools = message.tools.filter((tool) => !cardIds.has(tool.id))
  }

  const groups = new Map<
    string,
    { userLocalId: string; turn: string | number; cards: SessionPresentationCard[] }
  >()
  for (const card of cards) {
    const users = next
      .map((message, index) => (message.role === 'user' ? index : -1))
      .filter((index) => index >= 0)
    const localTurnIndex = card.turn_index == null ? null : card.turn_index - 1 - userTurnOffset
    const userIndex =
      localTurnIndex != null && localTurnIndex >= 0 && users[localTurnIndex] != null
        ? users[localTurnIndex]
        : undefined
    if (userIndex == null) {
      unattached.push(card)
      continue
    }
    const turn = card.turn_id ?? card.turn_index ?? userIndex
    if (turn == null) {
      unattached.push(card)
      continue
    }
    const key = `${userIndex}\u0000${turn}`
    const group = groups.get(key)
    if (group) group.cards.push(card)
    else {
      const user = next[userIndex]
      if (!user) {
        unattached.push(card)
        continue
      }
      groups.set(key, { userLocalId: user.localId, turn, cards: [card] })
    }
  }

  for (const { userLocalId, turn, cards: turnCards } of groups.values()) {
    // Earlier presentation segments change physical array indices. The user
    // row's durable local ID remains stable, so resolve it immediately before
    // each placement instead of retaining an index from before a splice.
    const userIndex = next.findIndex(
      (message) => message.role === 'user' && message.localId === userLocalId,
    )
    if (userIndex < 0) {
      unattached.push(...turnCards)
      continue
    }
    const localId = `presentation-turn-${turn}`
    const existing = next.find((message) => message.localId === localId)
    if (existing) {
      existing.tools = mergePresentationTools(existing.tools, turnCards)
      existing.streaming = existing.tools.some((tool) => tool.status === 'running')
      continue
    }

    const assistants: number[] = []
    for (
      let index = userIndex + 1;
      index < next.length && next[index]?.role !== 'user';
      index += 1
    ) {
      if (next[index]?.role === 'assistant') assistants.push(index)
    }

    if (assistants.length === 1) {
      // With just the final response in history, MessageRow's timeline sits
      // before its prose, exactly where the provider call occurred.
      const host = next[assistants[0]!]
      // A running card cannot precede the only non-empty assistant segment:
      // that segment is persisted interim commentary and the final answer has
      // not been written yet. Put a transient activity row after it instead.
      if (
        host &&
        !(turnCards.some((card) => card.status === 'running') && (host.content || host.thinking))
      ) {
        host.tools = mergePresentationTools(host.tools, turnCards)
        continue
      }
    }

    // Do not attach a hosted card to persisted commentary. ActivityTimeline
    // renders before prose, which would otherwise put a later tool above the
    // thought. A dedicated segment immediately before the final assistant
    // preserves commentary -> hosted tool -> final on a cold page reload.
    // With no assistant yet, it simply follows the user turn.
    const insertAt = assistants.length > 1 ? assistants.at(-1)! : (assistants[0] ?? userIndex) + 1
    const segment: ChatMessage = {
      localId,
      role: 'assistant',
      content: '',
      thinking: '',
      tools: mergePresentationTools([], turnCards),
      todos: [],
      subagents: [],
      streaming: turnCards.some((card) => card.status === 'running'),
    }
    next.splice(insertAt, 0, segment)
  }
  return { messages: next, unattached: mergePresentationTools([], unattached) }
}
