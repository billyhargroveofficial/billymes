import { describe, expect, it } from 'vitest'
import {
  parseLearningGraph,
  parseLearningNode,
  parseMemoryStatus,
  parseOauthStatus,
  parseProviderConfig,
} from './memory-api'

const GRAPH_PAYLOAD = {
  nodes: [
    {
      id: 'mujik-remote-access',
      label: 'mujik-remote-access',
      kind: 'skill',
      timestamp: 1_787_646_258,
      category: 'ops',
      useCount: 19,
      state: 'active',
      createdBy: 'agent',
      pinned: false,
    },
    {
      id: 'memory:memory:0',
      label: 'Lightpanda',
      kind: 'memory',
      memorySource: 'memory',
      timestamp: 1_787_594_565,
      category: 'memory',
      useCount: 0,
      state: 'active',
      createdBy: 'memory',
      pinned: false,
    },
  ],
  edges: [{ source: 'avito-headed-browser', target: 'mujik-remote-access' }],
  clusters: [{ category: 'memory', count: 20 }],
  memory: [
    { source: 'memory', timestamp: 1_787_594_565, title: 'Lightpanda', body: 'бинарь в кэше' },
  ],
  stats: {
    nodes: 40,
    related_edges: 28,
    edges_per_node: 0.7,
    linked_nodes: 26,
    isolated_pct: 35,
    categories: 10,
    agent_created: 35,
    used: 39,
    top_categories: [
      ['research', 10],
      ['ops', 3],
    ],
    memory_nodes: 20,
    memory_skill_edges: 36,
    learned_skills: 40,
  },
}

describe('parseLearningGraph', () => {
  it('reads the live payload shape', () => {
    const graph = parseLearningGraph(GRAPH_PAYLOAD)
    expect(graph.nodes).toHaveLength(2)
    expect(graph.nodes[0]).toMatchObject({ kind: 'skill', useCount: 19, createdBy: 'agent' })
    expect(graph.nodes[0]?.memorySource).toBeNull()
    expect(graph.nodes[1]).toMatchObject({ kind: 'memory', memorySource: 'memory' })
    expect(graph.memory[0]?.body).toBe('бинарь в кэше')
    expect(graph.stats.topCategories).toEqual([
      { category: 'research', count: 10 },
      { category: 'ops', count: 3 },
    ])
    expect(graph.stats).toMatchObject({
      relatedEdges: 28,
      edgesPerNode: 0.7,
      isolatedPct: 35,
      memorySkillEdges: 36,
      learnedSkills: 40,
    })
  })

  it('tolerates a graph with no memory, edges, or stats', () => {
    const graph = parseLearningGraph({ nodes: [] })
    expect(graph).toMatchObject({ nodes: [], edges: [], clusters: [], memory: [] })
    expect(graph.stats.learnedSkills).toBe(0)
  })

  it('rejects a payload that is not an object', () => {
    expect(() => parseLearningGraph([])).toThrow(/learning graph/)
    expect(() => parseLearningGraph({ nodes: [{ label: 'no id' }] })).toThrow(/nodes\[0\]\.id/)
  })
})

describe('parseLearningNode', () => {
  it('keeps the content and falls back to the requested id', () => {
    expect(
      parseLearningNode({ ok: true, kind: 'memory', content: 'тело' }, 'memory:memory:0'),
    ).toEqual({ id: 'memory:memory:0', kind: 'memory', label: 'memory:memory:0', content: 'тело' })
  })

  it('treats anything but "memory" as a skill', () => {
    expect(
      parseLearningNode({ kind: 'skill', id: 'a', label: 'a', content: '# a' }, 'a').kind,
    ).toBe('skill')
  })
})

describe('parseMemoryStatus', () => {
  it('reads providers, setup requirements, and builtin file sizes', () => {
    const status = parseMemoryStatus({
      active: '',
      providers: [
        {
          name: 'byterover',
          description: 'ByteRover',
          available: false,
          configured: true,
          status: 'unavailable',
          setup: {
            pip_dependencies: [],
            external_dependencies: [{ name: 'brv', install: 'curl …', check: 'brv --version' }],
            required_env: [],
            dependencies_installed: false,
          },
        },
        {
          name: 'retaindb',
          description: 'RetainDB',
          available: false,
          configured: false,
          status: 'needs_config',
          setup: {
            pip_dependencies: ['requests'],
            external_dependencies: [],
            required_env: ['RETAINDB_API_KEY'],
            dependencies_installed: true,
          },
        },
      ],
      builtin_files: { memory: 2645, user: 2218 },
    })

    expect(status.active).toBe('')
    expect(status.providers[0]?.setup.externalDependencies[0]?.name).toBe('brv')
    expect(status.providers[1]?.status).toBe('needs_config')
    expect(status.providers[1]?.setup.requiredEnv).toEqual(['RETAINDB_API_KEY'])
    expect(status.builtinFiles).toEqual([
      { name: 'memory', bytes: 2645 },
      { name: 'user', bytes: 2218 },
    ])
  })

  it('falls back to "unavailable" for an unknown status word', () => {
    const status = parseMemoryStatus({
      providers: [{ name: 'x', status: 'weird' }],
    })
    expect(status.providers[0]?.status).toBe('unavailable')
    expect(status.providers[0]?.setup.dependenciesInstalled).toBe(false)
  })
})

describe('parseProviderConfig', () => {
  it('normalises fields and stringifies non-string values', () => {
    const config = parseProviderConfig(
      {
        name: 'holographic',
        label: 'Holographic',
        fields: [
          {
            key: 'hrr_dim',
            label: 'Hrr Dim',
            kind: 'text',
            description: 'HRR vector dimensions',
            value: 1024,
            is_set: true,
            options: [],
          },
          {
            key: 'auto_extract',
            kind: 'select',
            value: 'false',
            options: [
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
            ],
          },
        ],
      },
      'holographic',
    )
    expect(config.fields[0]?.value).toBe('1024')
    expect(config.fields[1]?.label).toBe('auto_extract')
    expect(config.fields[1]?.options).toHaveLength(2)
  })
})

describe('parseOauthStatus', () => {
  it('keeps known states and clamps unknown ones to idle', () => {
    expect(parseOauthStatus({ state: 'pending', detail: 'ждём', connected: false })).toEqual({
      state: 'pending',
      detail: 'ждём',
      connected: false,
    })
    expect(parseOauthStatus({ state: 'nonsense' }).state).toBe('idle')
  })
})
