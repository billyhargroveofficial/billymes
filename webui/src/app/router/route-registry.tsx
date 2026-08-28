import { lazy, type ComponentType } from 'react'
import {
  Bot,
  Boxes,
  BrainCircuit,
  ChartSpline,
  Cpu,
  KeyRound,
  MessageSquare,
  Plug,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { ChatPage } from '@/features/chat'

const skillsRoute = lazy(async () => {
  const feature = await import('@/features/catalog')
  return { default: feature.SkillsPage }
})

const toolsRoute = lazy(async () => {
  const feature = await import('@/features/catalog')
  return { default: feature.ToolsPage }
})

const mcpRoute = lazy(async () => {
  const feature = await import('@/features/catalog')
  return { default: feature.McpPage }
})

const modelsRoute = lazy(async () => {
  const feature = await import('@/features/models')
  return { default: feature.ModelsPage }
})

const profilesRoute = lazy(async () => {
  const feature = await import('@/features/profile-management')
  return { default: feature.ProfilesPage }
})

const providersRoute = lazy(async () => {
  const feature = await import('@/features/providers')
  return { default: feature.ProvidersPage }
})

const insightsRoute = lazy(async () => {
  const feature = await import('@/features/insights')
  return { default: feature.InsightsPage }
})

const memoryRoute = lazy(async () => {
  const feature = await import('@/features/memory')
  return { default: feature.MemoryPage }
})

export type AppRoute = {
  path: `/${string}`
  label: string
  icon: LucideIcon
  page: ComponentType
  /** Warms the route chunk on nav hover/focus so the first click feels instant. */
  preload?: () => void
}

const preloadCatalog = () => void import('@/features/catalog')

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/', label: 'Чаты', icon: MessageSquare, page: ChatPage },
  { path: '/skills', label: 'Скиллы', icon: Sparkles, page: skillsRoute, preload: preloadCatalog },
  { path: '/tools', label: 'Тулы', icon: Bot, page: toolsRoute, preload: preloadCatalog },
  { path: '/mcp', label: 'MCP', icon: Plug, page: mcpRoute, preload: preloadCatalog },
  { path: '/models', label: 'Модели', icon: Cpu, page: modelsRoute },
  {
    path: '/providers',
    label: 'Доступы',
    icon: KeyRound,
    page: providersRoute,
    preload: () => void import('@/features/providers'),
  },
  {
    path: '/insights',
    label: 'Аналитика',
    icon: ChartSpline,
    page: insightsRoute,
    preload: () => void import('@/features/insights'),
  },
  {
    path: '/memory',
    label: 'Память',
    icon: BrainCircuit,
    page: memoryRoute,
    preload: () => void import('@/features/memory'),
  },
  { path: '/profiles', label: 'Профили', icon: Boxes, page: profilesRoute },
]

export function routeIsActive(route: AppRoute, pathname: string) {
  return route.path === '/' ? pathname === '/' : pathname.startsWith(route.path)
}
