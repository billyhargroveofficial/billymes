import { describe, expect, it } from 'vitest'
import { APP_ROUTES, routeIsActive } from './route-registry'

describe('route registry', () => {
  it('owns unique routes and labels for every navigation entry', () => {
    expect(APP_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/skills',
      '/tools',
      '/mcp',
      '/models',
      '/providers',
      '/insights',
      '/memory',
      '/profiles',
    ])
    expect(new Set(APP_ROUTES.map((route) => route.label)).size).toBe(APP_ROUTES.length)
  })

  it('offers a preload hint for the routes whose chunks are worth warming', () => {
    expect(APP_ROUTES.filter((route) => route.preload).length).toBeGreaterThan(0)
  })

  it('does not mark the root chat route active on another page', () => {
    expect(routeIsActive(APP_ROUTES[0]!, '/skills')).toBe(false)
    expect(routeIsActive(APP_ROUTES[1]!, '/skills/detail')).toBe(true)
  })
})
