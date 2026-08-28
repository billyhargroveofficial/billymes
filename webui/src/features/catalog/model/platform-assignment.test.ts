import { describe, expect, it } from 'vitest'
import {
  assignedToolsets,
  buildDisabledToolsetsPatch,
  buildPlatformAssignmentPatch,
  describeAssignment,
  knownToolsetKeys,
  platformOptions,
  restrictedPlatform,
} from './platform-assignment'
import type { MessagingPlatform, Toolset, ToolPolicyConfig } from './types'

function toolset(overrides: Partial<Toolset> = {}): Toolset {
  return {
    name: 'web',
    label: 'Web Search',
    description: '',
    platform: 'cli',
    platform_label: 'CLI',
    enabled: true,
    available: true,
    configured: true,
    tools: ['web_search', 'web_extract'],
    ...overrides,
  }
}

function config(overrides: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    platformToolsets: {
      cli: ['browser', 'gemini_search', 'hermes-cli', 'web'],
      discord: ['hermes-discord'],
    },
    knownBuiltinToolsets: { cli: ['browser', 'discord', 'web'] },
    knownPluginToolsets: { cli: ['workflow'] },
    disabledToolsets: ['bfl', 'image_gen'],
    toolSearch: {},
    toolOutput: {},
    terminalBackend: 'local',
    ...overrides,
  }
}

const KNOWN = knownToolsetKeys(config(), [toolset(), toolset({ name: 'browser' })])

describe('toolset platform assignment', () => {
  it('reads the restriction off the toolset row Hermes already returns', () => {
    expect(restrictedPlatform(toolset())).toBeNull()
    expect(restrictedPlatform(toolset({ name: 'discord_admin', platform: 'discord' }))).toBe(
      'discord',
    )
  })

  it('treats only recognised keys as toolsets, never composites or MCP names', () => {
    expect([...assignedToolsets(config(), 'cli', KNOWN)].sort()).toEqual(['browser', 'web'])
    const assignment = describeAssignment(config(), toolset(), 'cli', KNOWN)
    expect(assignment).toMatchObject({ explicit: true, assigned: true, locked: null })
    expect(assignment.extras).toEqual(['gemini_search', 'hermes-cli'])
  })

  it('locks a platform that has no list of its own instead of narrowing it', () => {
    const assignment = describeAssignment(config(), toolset(), 'telegram', KNOWN)
    expect(assignment.explicit).toBe(false)
    expect(assignment.locked).toContain('набор по умолчанию')
    expect(buildPlatformAssignmentPatch(config(), toolset(), 'telegram', true, KNOWN)).toBeNull()
  })

  it('locks a restricted toolset everywhere but its own platform', () => {
    const admin = toolset({ name: 'discord_admin', platform: 'discord' })
    expect(describeAssignment(config(), admin, 'cli', KNOWN).locked).toContain('discord')
    expect(buildPlatformAssignmentPatch(config(), admin, 'cli', true, KNOWN)).toBeNull()
    expect(buildPlatformAssignmentPatch(config(), admin, 'discord', true, KNOWN)).toEqual({
      platform_toolsets: { discord: ['discord_admin', 'hermes-discord'] },
    })
  })

  it('rebuilds the whole list on add and remove, keeping unrelated entries', () => {
    const added = buildPlatformAssignmentPatch(
      config(),
      toolset({ name: 'workflow' }),
      'cli',
      true,
      KNOWN,
    )
    expect(added).toEqual({
      platform_toolsets: { cli: ['browser', 'gemini_search', 'hermes-cli', 'web', 'workflow'] },
    })
    const removed = buildPlatformAssignmentPatch(config(), toolset(), 'cli', false, KNOWN)
    expect(removed).toEqual({
      platform_toolsets: { cli: ['browser', 'gemini_search', 'hermes-cli'] },
    })
  })

  it('sends nothing when the assignment already matches', () => {
    expect(buildPlatformAssignmentPatch(config(), toolset(), 'cli', true, KNOWN)).toBeNull()
    expect(
      buildPlatformAssignmentPatch(config(), toolset({ name: 'workflow' }), 'cli', false, KNOWN),
    ).toBeNull()
  })
})

describe('global deny list', () => {
  it('adds and removes the toolset without touching the rest of the list', () => {
    expect(buildDisabledToolsetsPatch(config(), 'web', true)).toEqual({
      agent: { disabled_toolsets: ['bfl', 'image_gen', 'web'] },
    })
    expect(buildDisabledToolsetsPatch(config(), 'bfl', false)).toEqual({
      agent: { disabled_toolsets: ['image_gen'] },
    })
  })

  it('sends nothing when the deny list already says so', () => {
    expect(buildDisabledToolsetsPatch(config(), 'bfl', true)).toBeNull()
    expect(buildDisabledToolsetsPatch(config(), 'web', false)).toBeNull()
  })
})

describe('platform ordering', () => {
  const platforms: MessagingPlatform[] = [
    { id: 'telegram', name: 'Telegram', enabled: true, configured: true, state: 'connected' },
    { id: 'signal', name: 'Signal', enabled: false, configured: false, state: 'disabled' },
    { id: 'discord', name: 'Discord', enabled: false, configured: false, state: 'disabled' },
  ]

  it('puts the CLI first, then platforms with a list, then connected ones', () => {
    const rows = platformOptions(config(), platforms)
    expect(rows.map((row) => row.id)).toEqual(['cli', 'discord', 'telegram', 'signal'])
    expect(rows.map((row) => row.primary)).toEqual([true, true, true, false])
    expect(rows[0]?.label).toBe('CLI / десктоп')
    expect(rows[1]?.label).toBe('Discord')
  })
})
