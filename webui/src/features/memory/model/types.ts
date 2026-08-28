/** Shapes returned by the Hermes learning-graph and memory-backend endpoints. */

export type LearningNodeKind = 'skill' | 'memory'

export type LearningNode = {
  id: string
  label: string
  kind: LearningNodeKind
  timestamp: number
  category: string
  useCount: number
  state: string
  createdBy: string | null
  pinned: boolean
  memorySource: string | null
}

export type LearningEdge = {
  source: string
  target: string
}

export type LearningCluster = {
  category: string
  count: number
}

export type MemoryChunk = {
  source: string
  timestamp: number
  title: string
  body: string
}

/** A memory chunk paired with the graph node id that addresses it. */
export type MemoryEntry = MemoryChunk & { id: string }

export type LearningStats = {
  nodes: number
  relatedEdges: number
  edgesPerNode: number
  linkedNodes: number
  isolatedPct: number
  categories: number
  agentCreated: number
  used: number
  topCategories: LearningCluster[]
  memoryNodes: number
  memorySkillEdges: number
  learnedSkills: number
}

export type LearningGraph = {
  nodes: LearningNode[]
  edges: LearningEdge[]
  clusters: LearningCluster[]
  memory: MemoryChunk[]
  stats: LearningStats
}

/** `GET /api/learning/node` — the editable source of one node. */
export type LearningNodeDetail = {
  id: string
  kind: LearningNodeKind
  label: string
  content: string
}

export type MemoryProviderStatus = 'ready' | 'unavailable' | 'needs_config'

type MemoryExternalDependency = {
  name: string
  install: string
  check: string
}

type MemoryProviderSetup = {
  pipDependencies: string[]
  externalDependencies: MemoryExternalDependency[]
  requiredEnv: string[]
  dependenciesInstalled: boolean
}

export type MemoryProvider = {
  name: string
  description: string
  available: boolean
  configured: boolean
  status: MemoryProviderStatus
  setup: MemoryProviderSetup
}

export type BuiltinMemoryFile = {
  name: string
  bytes: number
}

export type MemoryStatus = {
  active: string
  providers: MemoryProvider[]
  builtinFiles: BuiltinMemoryFile[]
}

type ProviderFieldOption = {
  value: string
  label: string
  description: string
}

export type ProviderField = {
  key: string
  label: string
  kind: string
  description: string
  placeholder: string
  required: boolean
  value: string
  isSet: boolean
  options: ProviderFieldOption[]
  url: string
}

export type ProviderConfig = {
  name: string
  label: string
  fields: ProviderField[]
}

export type OauthState = 'idle' | 'pending' | 'connected' | 'error'

export type MemoryOauthStatus = {
  state: OauthState
  detail: string
  connected: boolean
}

/** `MemoryReset.target` — the gateway accepts exactly these three scopes. */
export type ResetTarget = 'memory' | 'user' | 'all'
