import { describe, expect, it, vi } from 'vitest'
import {
  mergePresentationIntoMessages,
  PresentationTerminalReconciler,
  refreshesPresentationLedger,
  runPresentationTerminalReconciliation,
} from './presentation-tools'
import type { ChatMessage } from './types'

const message = (role: ChatMessage['role'], localId: string): ChatMessage => ({
  localId,
  role,
  content: '',
  thinking: '',
  tools: [],
  todos: [],
  subagents: [],
  streaming: false,
})

const hostedCard = (id: string, sequence: number, turnIndex = 1, turnId = 'turn-1') => ({
  id,
  sequence,
  origin: 'hosted' as const,
  name: 'web_search',
  args: JSON.stringify({ query: id }),
  preview: id,
  status: 'done' as const,
  ok: true,
  duration_s: 1,
  started_at: 0,
  completed_at: 1,
  turn_id: turnId,
  turn_index: turnIndex,
})

describe('durable hosted presentation projection', () => {
  it('reconciles a ledger-only hosted batch when the turn becomes terminal', () => {
    expect(
      refreshesPresentationLedger({
        type: 'tool.complete',
        payload: { tool_id: 'hosted_search_1', name: 'web_search' },
      }),
    ).toBe(false)
    // The terminal fallback repairs a lost lifecycle before F5 without adding
    // one ledger RPC for each card in a hosted batch.
    expect(refreshesPresentationLedger({ type: 'message.complete' })).toBe(true)
    expect(refreshesPresentationLedger({ type: 'turn.end' })).toBe(true)
    expect(refreshesPresentationLedger({ type: 'error' })).toBe(true)

    const user = message('user', 'user-1')
    user.content = 'Search the web'
    const commentary = message('assistant', 'commentary-1')
    commentary.content = 'I will check that first.'
    const final = message('assistant', 'final-1')
    final.content = 'Here is the answer.'
    const result = mergePresentationIntoMessages(
      [user, commentary, final],
      [hostedCard('hosted-search-1', 1)],
    )

    expect(result.messages.map((item) => item.content)).toEqual([
      'Search the web',
      'I will check that first.',
      '',
      'Here is the answer.',
    ])
    expect(result.messages[2]?.tools).toEqual([
      expect.objectContaining({ id: 'hosted-search-1', status: 'done' }),
    ])
  })

  it('deduplicates duplicate terminal events from one turn without a trailing read', () => {
    const reconciler = new PresentationTerminalReconciler()

    reconciler.markTurnSubmitted('session-1')
    expect(reconciler.beginTerminal('session-1')).toBe(true)
    expect(reconciler.beginTerminal('session-1')).toBe(false)
    expect(reconciler.finish('session-1')).toBe(false)
    // A repeated message.complete + turn.end must not set dirty for the same
    // stable local turn generation.

    reconciler.markTurnSubmitted('session-1')
    expect(reconciler.beginTerminal('session-1')).toBe(true)
    expect(reconciler.finish('session-1')).toBe(false)
  })

  it('runs one trailing reconciliation when a fast next turn ends in flight', () => {
    const reconciler = new PresentationTerminalReconciler()

    reconciler.markTurnSubmitted('session-1')
    expect(reconciler.beginTerminal('session-1')).toBe(true)
    // The next local submit creates a distinct generation before its terminal
    // event arrives, so it is not mistaken for a duplicate turn.end.
    reconciler.markTurnSubmitted('session-1')
    expect(reconciler.beginTerminal('session-1')).toBe(false)
    expect(reconciler.finish('session-1')).toBe(true)
    expect(reconciler.finish('session-1')).toBe(false)
  })

  it('invokes no trailing load for duplicate terminal events but one for a fast next turn', async () => {
    const reconciler = new PresentationTerminalReconciler()
    let finishFirst: (() => void) | undefined
    let finishTrailing: (() => void) | undefined
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          if (!finishFirst) finishFirst = resolve
          else finishTrailing = resolve
        }),
    )

    reconciler.markTurnSubmitted('session-1')
    runPresentationTerminalReconciliation(reconciler, 'session-1', load)
    runPresentationTerminalReconciliation(reconciler, 'session-1', load)
    expect(load).toHaveBeenCalledTimes(1)

    finishFirst?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)

    reconciler.markTurnSubmitted('session-1')
    runPresentationTerminalReconciliation(reconciler, 'session-1', load)
    expect(load).toHaveBeenCalledTimes(2)

    // A separate next turn ends before this request settles: exactly one
    // trailing request is started after the current ledger snapshot resolves.
    reconciler.markTurnSubmitted('session-1')
    runPresentationTerminalReconciliation(reconciler, 'session-1', load)
    finishTrailing?.()
    await Promise.resolve()
    await Promise.resolve()
    runPresentationTerminalReconciliation(reconciler, 'session-1', load)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('places cards into their own turn segment ordered by sequence', () => {
    const messages = [
      message('user', 'u1'),
      message('assistant', 'a1'),
      message('user', 'u2'),
      message('assistant', 'a2'),
    ]
    const cards = [
      {
        id: 'b',
        sequence: 2,
        origin: 'hosted' as const,
        name: 'web.search',
        args: '',
        preview: 'second',
        status: 'done' as const,
        ok: true,
        duration_s: 2,
        started_at: 0,
        completed_at: 0,
        turn_id: 't2',
        turn_index: 2,
      },
      {
        id: 'a',
        sequence: 1,
        origin: 'hosted' as const,
        name: 'web.search',
        args: '',
        preview: 'first',
        status: 'done' as const,
        ok: true,
        duration_s: 1,
        started_at: 0,
        completed_at: 0,
        turn_id: 't2',
        turn_index: 2,
      },
    ]
    const result = mergePresentationIntoMessages(messages, cards)
    expect(result.messages[1]!.tools).toEqual([])
    expect(result.messages[3]!.tools.map((tool) => tool.id)).toEqual(['a', 'b'])
  })

  it('keeps all four cards from one hosted search batch in ledger sequence on cold reload', () => {
    const result = mergePresentationIntoMessages(
      [message('user', 'u1'), message('assistant', 'a1')],
      [
        hostedCard('search-4', 4),
        hostedCard('search-2', 2),
        hostedCard('search-1', 1),
        hostedCard('search-3', 3),
      ],
    )

    expect(result.messages[1]!.tools.map((tool) => tool.id)).toEqual([
      'search-1',
      'search-2',
      'search-3',
      'search-4',
    ])
  })

  it('keeps cards bound to their own user turn after earlier cold segments splice the list', () => {
    const firstCommentary = message('assistant', 'commentary-1')
    firstCommentary.content = 'Сначала первый поиск.'
    const firstFinal = message('assistant', 'final-1')
    firstFinal.content = 'Первый ответ.'
    const secondCommentary = message('assistant', 'commentary-2')
    secondCommentary.content = 'Теперь второй поиск.'
    const secondFinal = message('assistant', 'final-2')
    secondFinal.content = 'Второй ответ.'

    const result = mergePresentationIntoMessages(
      [
        message('user', 'u1'),
        firstCommentary,
        firstFinal,
        message('user', 'u2'),
        secondCommentary,
        secondFinal,
      ],
      [hostedCard('first-search', 1, 1, 'turn-1'), hostedCard('second-search', 2, 2, 'turn-2')],
    )

    expect(result.messages.map((row) => row.localId)).toEqual([
      'u1',
      'commentary-1',
      'presentation-turn-turn-1',
      'final-1',
      'u2',
      'commentary-2',
      'presentation-turn-turn-2',
      'final-2',
    ])
    expect(result.messages[2]?.tools.map((tool) => tool.id)).toEqual(['first-search'])
    expect(result.messages[6]?.tools.map((tool) => tool.id)).toEqual(['second-search'])
  })

  it('attaches a previously unattached durable card after an earlier history page arrives', () => {
    const cards = [
      hostedCard('first-search', 1, 1, 'turn-1'),
      hostedCard('second-search', 2, 2, 'turn-2'),
    ]
    const latest = mergePresentationIntoMessages(
      [message('user', 'u2'), message('assistant', 'a2')],
      cards,
      1,
    )
    expect(latest.unattached.map((card) => card.id)).toEqual(['first-search'])

    const hydrated = mergePresentationIntoMessages(
      [message('user', 'u1'), message('assistant', 'a1'), ...latest.messages],
      cards,
    )
    expect(hydrated.unattached).toEqual([])
    expect(hydrated.messages.flatMap((row) => row.tools).map((tool) => tool.id)).toEqual([
      'first-search',
      'second-search',
    ])
  })

  it('relocates an already-live card instead of duplicating it on ledger reload', () => {
    const first = message('assistant', 'a1')
    first.tools = [
      {
        id: 'hosted',
        name: 'web.search',
        args: '',
        result: '',
        status: 'running',
      },
    ]
    const result = mergePresentationIntoMessages(
      [message('user', 'u1'), first, message('user', 'u2'), message('assistant', 'a2')],
      [
        {
          id: 'hosted',
          sequence: 1,
          origin: 'hosted',
          name: 'web.search',
          args: '',
          preview: 'done',
          status: 'done',
          ok: true,
          duration_s: 1,
          started_at: 0,
          completed_at: 1,
          turn_id: 't2',
          turn_index: 2,
        },
      ],
    )
    expect(result.messages[1]!.tools).toEqual([])
    expect(result.messages[3]!.tools).toMatchObject([{ id: 'hosted', status: 'done' }])
  })

  it('keeps commentary above hosted activity and the final answer below it', () => {
    const commentary = message('assistant', 'commentary')
    commentary.content = 'Сначала проверю источники.'
    const final = message('assistant', 'final')
    final.content = 'Готово: вот ответ.'
    const result = mergePresentationIntoMessages(
      [message('user', 'u1'), commentary, final],
      [
        {
          id: 'hosted-search',
          sequence: 1,
          origin: 'hosted',
          name: 'web_search',
          args: '{"query":"Hermes"}',
          preview: 'Hermes',
          status: 'done',
          ok: true,
          duration_s: 1.2,
          started_at: 0,
          completed_at: 1.2,
          turn_id: 'turn-1',
          turn_index: 1,
        },
      ],
    )

    expect(result.messages.map((row) => row.localId)).toEqual([
      'u1',
      'commentary',
      'presentation-turn-turn-1',
      'final',
    ])
    expect(result.messages[1]?.tools).toEqual([])
    expect(result.messages[2]?.tools).toMatchObject([{ id: 'hosted-search' }])
    expect(result.messages[3]?.tools).toEqual([])
  })

  it('puts a running cold-replayed card after the only interim segment', () => {
    const commentary = message('assistant', 'commentary')
    commentary.content = 'Проверяю источники.'
    const result = mergePresentationIntoMessages(
      [message('user', 'u1'), commentary],
      [
        {
          id: 'still-running',
          sequence: 1,
          origin: 'hosted',
          name: 'web_search',
          args: '',
          preview: 'Hermes',
          status: 'running',
          ok: null,
          duration_s: null,
          started_at: 0,
          completed_at: null,
          turn_id: 'turn-1',
          turn_index: 1,
        },
      ],
    )

    expect(result.messages.map((row) => row.localId)).toEqual([
      'u1',
      'commentary',
      'presentation-turn-turn-1',
    ])
  })
})
