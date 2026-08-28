import {
  expectArray,
  expectRecord,
  expectString,
  optionalString,
  requestJson,
  withProfile,
} from '@/shared/api'
import type {
  LearningCluster,
  LearningEdge,
  LearningGraph,
  LearningNode,
  LearningNodeDetail,
  LearningNodeKind,
  LearningStats,
  MemoryChunk,
  MemoryOauthStatus,
  MemoryProvider,
  MemoryProviderStatus,
  MemoryStatus,
  OauthState,
  ProviderConfig,
  ProviderField,
  ResetTarget,
} from '../model/types'

const PROVIDER_STATUSES: readonly MemoryProviderStatus[] = ['ready', 'unavailable', 'needs_config']
const OAUTH_STATES: readonly OauthState[] = ['idle', 'pending', 'connected', 'error']

function text(value: unknown) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

function numberOr(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOr(value: unknown, fallback = false) {
  return typeof value === 'boolean' ? value : fallback
}

function strings(value: unknown, label: string) {
  return expectArray(value ?? [], label).map((item, index) => text(item) || `${label}[${index}]`)
}

function nodeKind(value: unknown): LearningNodeKind {
  return value === 'memory' ? 'memory' : 'skill'
}

function parseNode(value: unknown, index: number): LearningNode {
  const label = `learning graph.nodes[${index}]`
  const row = expectRecord(value, label)
  return {
    id: expectString(row.id, `${label}.id`),
    label: text(row.label),
    kind: nodeKind(row.kind),
    timestamp: numberOr(row.timestamp),
    category: text(row.category),
    useCount: numberOr(row.useCount),
    state: text(row.state),
    createdBy: optionalString(row.createdBy, `${label}.createdBy`),
    pinned: booleanOr(row.pinned),
    memorySource: optionalString(row.memorySource, `${label}.memorySource`),
  }
}

function parseEdge(value: unknown, index: number): LearningEdge {
  const label = `learning graph.edges[${index}]`
  const row = expectRecord(value, label)
  return {
    source: expectString(row.source, `${label}.source`),
    target: expectString(row.target, `${label}.target`),
  }
}

function parseCluster(value: unknown, index: number, label: string): LearningCluster {
  const row = expectRecord(value, `${label}[${index}]`)
  return { category: text(row.category), count: numberOr(row.count) }
}

function parseChunk(value: unknown, index: number): MemoryChunk {
  const label = `learning graph.memory[${index}]`
  const row = expectRecord(value, label)
  return {
    source: text(row.source),
    timestamp: numberOr(row.timestamp),
    title: text(row.title),
    body: text(row.body),
  }
}

/** `top_categories` arrives as `[[name, count], …]` rather than as objects. */
function parseTopCategories(value: unknown): LearningCluster[] {
  return expectArray(value ?? [], 'learning graph.stats.top_categories').map((entry, index) => {
    const pair = expectArray(entry, `learning graph.stats.top_categories[${index}]`)
    return { category: text(pair[0]), count: numberOr(pair[1]) }
  })
}

function parseStats(value: unknown): LearningStats {
  const row = expectRecord(value ?? {}, 'learning graph.stats')
  return {
    nodes: numberOr(row.nodes),
    relatedEdges: numberOr(row.related_edges),
    edgesPerNode: numberOr(row.edges_per_node),
    linkedNodes: numberOr(row.linked_nodes),
    isolatedPct: numberOr(row.isolated_pct),
    categories: numberOr(row.categories),
    agentCreated: numberOr(row.agent_created),
    used: numberOr(row.used),
    topCategories: parseTopCategories(row.top_categories),
    memoryNodes: numberOr(row.memory_nodes),
    memorySkillEdges: numberOr(row.memory_skill_edges),
    learnedSkills: numberOr(row.learned_skills),
  }
}

export function parseLearningGraph(value: unknown): LearningGraph {
  const row = expectRecord(value, 'learning graph')
  return {
    nodes: expectArray(row.nodes ?? [], 'learning graph.nodes').map(parseNode),
    edges: expectArray(row.edges ?? [], 'learning graph.edges').map(parseEdge),
    clusters: expectArray(row.clusters ?? [], 'learning graph.clusters').map((entry, index) =>
      parseCluster(entry, index, 'learning graph.clusters'),
    ),
    memory: expectArray(row.memory ?? [], 'learning graph.memory').map(parseChunk),
    stats: parseStats(row.stats),
  }
}

export function parseLearningNode(value: unknown, fallbackId: string): LearningNodeDetail {
  const row = expectRecord(value, 'learning node')
  return {
    id: text(row.id) || fallbackId,
    kind: nodeKind(row.kind),
    label: text(row.label) || fallbackId,
    content: text(row.content),
  }
}

function parseProvider(value: unknown, index: number): MemoryProvider {
  const label = `memory status.providers[${index}]`
  const row = expectRecord(value, label)
  const setup = expectRecord(row.setup ?? {}, `${label}.setup`)
  const status = text(row.status) as MemoryProviderStatus
  return {
    name: expectString(row.name, `${label}.name`),
    description: text(row.description),
    available: booleanOr(row.available),
    configured: booleanOr(row.configured),
    status: PROVIDER_STATUSES.includes(status) ? status : 'unavailable',
    setup: {
      pipDependencies: strings(setup.pip_dependencies, `${label}.setup.pip_dependencies`),
      externalDependencies: expectArray(
        setup.external_dependencies ?? [],
        `${label}.setup.external_dependencies`,
      ).map((entry, position) => {
        const dependency = expectRecord(entry, `${label}.setup.external_dependencies[${position}]`)
        return {
          name: text(dependency.name),
          install: text(dependency.install),
          check: text(dependency.check),
        }
      }),
      requiredEnv: strings(setup.required_env, `${label}.setup.required_env`),
      dependenciesInstalled: booleanOr(setup.dependencies_installed),
    },
  }
}

export function parseMemoryStatus(value: unknown): MemoryStatus {
  const row = expectRecord(value, 'memory status')
  const builtin = expectRecord(row.builtin_files ?? {}, 'memory status.builtin_files')
  return {
    active: text(row.active),
    providers: expectArray(row.providers ?? [], 'memory status.providers').map(parseProvider),
    builtinFiles: Object.entries(builtin).map(([name, bytes]) => ({
      name,
      bytes: numberOr(bytes),
    })),
  }
}

function parseField(value: unknown, index: number): ProviderField {
  const label = `provider config.fields[${index}]`
  const row = expectRecord(value, label)
  return {
    key: expectString(row.key, `${label}.key`),
    label: text(row.label) || text(row.key),
    kind: text(row.kind) || 'text',
    description: text(row.description),
    placeholder: text(row.placeholder),
    required: booleanOr(row.required),
    value: text(row.value),
    isSet: booleanOr(row.is_set),
    options: expectArray(row.options ?? [], `${label}.options`).map((entry, position) => {
      const option = expectRecord(entry, `${label}.options[${position}]`)
      return {
        value: text(option.value),
        label: text(option.label) || text(option.value),
        description: text(option.description),
      }
    }),
    url: text(row.url),
  }
}

export function parseProviderConfig(value: unknown, fallbackName: string): ProviderConfig {
  const row = expectRecord(value, 'provider config')
  return {
    name: text(row.name) || fallbackName,
    label: text(row.label) || fallbackName,
    fields: expectArray(row.fields ?? [], 'provider config.fields').map(parseField),
  }
}

export function parseOauthStatus(value: unknown): MemoryOauthStatus {
  const row = expectRecord(value, 'memory oauth status')
  const state = text(row.state) as OauthState
  return {
    state: OAUTH_STATES.includes(state) ? state : 'idle',
    detail: text(row.detail),
    connected: booleanOr(row.connected),
  }
}

function providerPath(name: string, suffix: string) {
  return `/api/memory/providers/${encodeURIComponent(name)}${suffix}`
}

export const memoryApi = {
  graph: async (profile?: string) =>
    parseLearningGraph(await requestJson(withProfile('/api/learning/graph', profile))),
  node: async (id: string, profile?: string) =>
    parseLearningNode(
      await requestJson(withProfile(`/api/learning/node?id=${encodeURIComponent(id)}`, profile)),
      id,
    ),
  saveNode: (id: string, content: string, profile?: string) =>
    requestJson('/api/learning/node', {
      method: 'PUT',
      body: JSON.stringify({ id, content, profile: profile ?? null }),
    }),
  deleteNode: (id: string, profile?: string) =>
    requestJson('/api/learning/node', {
      method: 'DELETE',
      body: JSON.stringify({ id, profile: profile ?? null }),
    }),
  /** Backend selection is gateway-wide: this endpoint takes no profile. */
  status: async () => parseMemoryStatus(await requestJson('/api/memory')),
  selectProvider: (provider: string) =>
    requestJson('/api/memory/provider', {
      method: 'PUT',
      body: JSON.stringify({ provider }),
    }),
  providerConfig: async (name: string, profile?: string) =>
    parseProviderConfig(
      await requestJson(withProfile(providerPath(name, '/config'), profile)),
      name,
    ),
  saveProviderConfig: (name: string, values: Record<string, string>, profile?: string) =>
    requestJson(withProfile(providerPath(name, '/config'), profile), {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),
  setupProvider: (name: string) =>
    requestJson(providerPath(name, '/setup'), { method: 'POST', body: JSON.stringify({}) }),
  startOauth: (name: string, profile?: string) =>
    requestJson(withProfile(providerPath(name, '/oauth/start'), profile), { method: 'POST' }),
  /**
   * Providers without a `plugins.memory.<name>.oauth_flow` module answer 404,
   * so a failed probe means "no OAuth surface" rather than a real outage.
   */
  oauthStatus: async (name: string, profile?: string): Promise<MemoryOauthStatus | null> => {
    try {
      return parseOauthStatus(
        await requestJson(withProfile(providerPath(name, '/oauth/status'), profile)),
      )
    } catch {
      return null
    }
  },
  reset: (target: ResetTarget) =>
    requestJson('/api/memory/reset', { method: 'POST', body: JSON.stringify({ target }) }),
}
