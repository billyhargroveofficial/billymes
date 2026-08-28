import { describe, expect, it } from 'vitest'
import {
  buildMemoryEntries,
  clusterBars,
  filterMemoryEntries,
  filterSkillNodes,
  formatBytes,
  formatCount,
  memorySourceCounts,
  plural,
  relativeTime,
  titleAddsInformation,
  RECORD_FORMS,
} from './graph-view'
import type { LearningNode, MemoryChunk } from './types'

function node(overrides: Partial<LearningNode>): LearningNode {
  return {
    id: 'skill-a',
    label: 'skill-a',
    kind: 'skill',
    timestamp: 1_787_000_000,
    category: 'ops',
    useCount: 1,
    state: 'active',
    createdBy: 'agent',
    pinned: false,
    memorySource: null,
    ...overrides,
  }
}

function chunk(overrides: Partial<MemoryChunk>): MemoryChunk {
  return {
    source: 'memory',
    timestamp: 1_787_000_000,
    title: 'заметка',
    body: 'тело',
    ...overrides,
  }
}

const NOW = 1_787_600_000_000

describe('russian plural forms', () => {
  it('picks the form the count actually needs', () => {
    expect(plural(1, RECORD_FORMS)).toBe('запись')
    expect(plural(3, RECORD_FORMS)).toBe('записи')
    expect(plural(11, RECORD_FORMS)).toBe('записей')
    expect(plural(21, RECORD_FORMS)).toBe('запись')
    expect(plural(0, RECORD_FORMS)).toBe('записей')
    expect(formatCount(60, RECORD_FORMS)).toBe('60 записей')
  })
})

describe('relativeTime', () => {
  it('steps through the units and refuses to invent a date', () => {
    expect(relativeTime(NOW / 1000 - 10, NOW)).toBe('только что')
    expect(relativeTime(NOW / 1000 - 120, NOW)).toBe('2 минуты назад')
    expect(relativeTime(NOW / 1000 - 3 * 3600, NOW)).toBe('3 часа назад')
    expect(relativeTime(NOW / 1000 - 5 * 86_400, NOW)).toBe('5 дней назад')
    expect(relativeTime(NOW / 1000 - 70 * 86_400, NOW)).toBe('2 месяца назад')
    expect(relativeTime(NOW / 1000 - 800 * 86_400, NOW)).toBe('2 года назад')
    expect(relativeTime(0, NOW)).toBe('без даты')
  })
})

describe('formatBytes', () => {
  it('keeps builtin memory file sizes short', () => {
    expect(formatBytes(0)).toBe('0 Б')
    expect(formatBytes(512)).toBe('512 Б')
    expect(formatBytes(2645)).toBe('2.6 КБ')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 МБ')
  })
})

describe('buildMemoryEntries', () => {
  it('pairs chunks with the node ids that address them', () => {
    const nodes = [
      node({ id: 'skill-a' }),
      node({ id: 'memory:memory:0', kind: 'memory', memorySource: 'memory' }),
      node({ id: 'memory:profile:1', kind: 'memory', memorySource: 'profile' }),
    ]
    const entries = buildMemoryEntries([chunk({}), chunk({ source: 'profile' })], nodes)
    expect(entries.map((entry) => entry.id)).toEqual(['memory:memory:0', 'memory:profile:1'])
  })

  it('falls back to the documented id shape when nodes are missing', () => {
    const entries = buildMemoryEntries([chunk({ source: 'profile' })], [])
    expect(entries[0]?.id).toBe('memory:profile:0')
  })
})

describe('filterMemoryEntries', () => {
  const entries = buildMemoryEntries(
    [
      chunk({ title: 'Lightpanda', body: 'бинарь в кэше', timestamp: 10 }),
      chunk({ title: 'Obsidian', body: 'billynotes', timestamp: 30 }),
      chunk({ title: 'профиль', body: 'предпочитает русский', source: 'profile', timestamp: 20 }),
    ],
    [],
  )

  it('sorts newest first and searches title and body', () => {
    expect(filterMemoryEntries(entries, '', '').map((entry) => entry.title)).toEqual([
      'Obsidian',
      'профиль',
      'Lightpanda',
    ])
    expect(filterMemoryEntries(entries, 'BILLYNOTES', '').map((entry) => entry.title)).toEqual([
      'Obsidian',
    ])
    expect(filterMemoryEntries(entries, '', 'profile').map((entry) => entry.title)).toEqual([
      'профиль',
    ])
    expect(filterMemoryEntries(entries, 'нет такого', '')).toEqual([])
  })

  it('counts sources for the filter switch', () => {
    expect(memorySourceCounts(entries)).toEqual([
      { category: 'memory', count: 2 },
      { category: 'profile', count: 1 },
    ])
  })
})

describe('filterSkillNodes', () => {
  const nodes = [
    node({ id: 'a', label: 'mujik-remote-access', useCount: 19, category: 'ops' }),
    node({ id: 'b', label: 'video-dubbing', useCount: 26, category: 'media' }),
    node({ id: 'c', label: 'mcp-server-setup', useCount: 26, category: 'ops' }),
    node({ id: 'm', kind: 'memory', label: 'воспоминание', useCount: 99, category: 'memory' }),
  ]

  it('drops memory nodes, ranks by use, then breaks ties by label', () => {
    expect(filterSkillNodes(nodes, '', '').map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
  })

  it('filters by query and by category', () => {
    expect(filterSkillNodes(nodes, 'mujik', '').map((entry) => entry.id)).toEqual(['a'])
    expect(filterSkillNodes(nodes, '', 'ops').map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(filterSkillNodes(nodes, '', 'nutrition')).toEqual([])
  })
})

describe('clusterBars', () => {
  it('scales against the biggest cluster and keeps small ones visible', () => {
    const bars = clusterBars([
      { category: 'ops', count: 3 },
      { category: 'memory', count: 20 },
      { category: 'empty', count: 0 },
    ])
    expect(bars.map((bar) => bar.category)).toEqual(['memory', 'ops'])
    expect(bars[0]?.percent).toBe(100)
    expect(bars[1]?.percent).toBe(15)
  })

  it('survives an empty graph', () => {
    expect(clusterBars([])).toEqual([])
  })
})

describe('titleAddsInformation', () => {
  it('rejects a title that is just the truncated body', () => {
    expect(
      titleAddsInformation(
        'Telegram можно использовать для проверок и контактов; пользователь отменил прежн…',
        'Telegram можно использовать для проверок и контактов; пользователь отменил прежний запрет.',
      ),
    ).toBe(false)
  })

  it('keeps a title that names something the body opening does not', () => {
    expect(titleAddsInformation('Доступ к Telegram', 'Пользователь отменил прежний запрет.')).toBe(
      true,
    )
  })

  it('rejects an empty or whitespace title', () => {
    expect(titleAddsInformation('   ', 'что-то важное')).toBe(false)
  })
})
