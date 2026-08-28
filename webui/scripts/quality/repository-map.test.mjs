import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildRepositoryMap } from './repository-map.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repositoryRoot, 'scripts/quality/repository-map.mjs')
const architecture = {
  sourceRoot: 'src',
  allowedRoots: ['app', 'features', 'shared'],
  legacyRoots: ['lib', 'components', 'pages', 'App.tsx'],
  featureRoot: 'features',
  featureManifest: 'module.json',
  publicEntry: 'index.ts',
  alias: '@/',
  maxProductionFileLines: 450,
  excludedDirectories: ['node_modules', 'dist'],
}

function featureManifest(id, dependencies = [], description = '') {
  return `${JSON.stringify({ id, description, dependencies }, null, 2)}\n`
}

function baseFiles() {
  return {
    'src/app/router/route-registry.tsx': [
      "import { ChatPage } from '@/features/chat'",
      'const profilesRoute = lazy(async () => {',
      "  const feature = await import('@/features/profiles')",
      '  return { default: feature.ProfilesPage }',
      '})',
      'export const APP_ROUTES = [',
      "  { path: '/', label: 'Chats', icon: MessageSquare, page: ChatPage },",
      "  { path: '/profiles', label: 'Profiles', icon: Boxes, page: profilesRoute },",
      '] as const',
    ].join('\n'),
    'src/app/main.tsx':
      "import { APP_ROUTES } from './router/route-registry'\nexport { APP_ROUTES }\n",
    'src/shared/index.ts': 'export const shared = true\n',
    'src/features/chat/module.json': featureManifest(
      'chat',
      ['profiles'],
      'Chat runtime and route.',
    ),
    'src/features/chat/index.ts': 'export const ChatPage = () => null\n',
    'src/features/profiles/module.json': featureManifest('profiles', [], 'Profile scope.'),
    'src/features/profiles/index.ts': 'export const ProfilesPage = () => null\n',
  }
}

async function createFixture(files, config = architecture) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-map-'))
  await writeFile(path.join(root, 'architecture.json'), `${JSON.stringify(config, null, 2)}\n`)
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
  }
  return root
}

async function withFixture(files, callback, config = architecture) {
  const root = await createFixture(files, config)
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('builds a deterministic map from architecture, features, public exports, and route registry', async () => {
  await withFixture(baseFiles(), async (root) => {
    const result = buildRepositoryMap(root)
    assert.deepEqual(
      result.routes.map((route) => ({
        path: route.path,
        page: route.page,
        feature: route.feature,
      })),
      [
        { path: '/', page: 'ChatPage', feature: 'chat' },
        { path: '/profiles', page: 'profilesRoute', feature: 'profiles' },
      ],
    )
    assert.deepEqual(
      result.features.map((feature) => feature.id),
      ['chat', 'profiles'],
    )
    assert.match(result.content, /Registry: `src\/app\/router\/route-registry\.tsx`/)
    assert.match(result.content, /`chat`[\s\S]*Dependencies: `profiles`/)
    assert.match(result.content, /Public exports: `ChatPage`/)
    assert.match(result.content, /\| `\/`\s+\| Chats\s+\| `ChatPage`\s+\| `chat`\s+\|/)
    assert.ok(!result.content.includes(root))
    assert.doesNotMatch(result.content, /Generated at|timestamp/i)
    assert.doesNotMatch(result.content, /\/(?:Users|private|tmp|var|home)\//)
  })
})

test('CLI write/check is idempotent and detects a stale generated artifact', async () => {
  await withFixture(baseFiles(), async (root) => {
    const write = spawnSync(process.execPath, [scriptPath, '--write', '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(write.status, 0)
    assert.match(write.stdout, /repository map written: docs\/generated\/repository-map\.md/)

    const generatedPath = path.join(root, 'docs/generated/repository-map.md')
    const generated = await readFile(generatedPath, 'utf8')
    assert.equal(generated, buildRepositoryMap(root).content)

    const check = spawnSync(process.execPath, [scriptPath, '--check', '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(check.status, 0)
    assert.match(check.stdout, /repository map is up to date/)

    await writeFile(generatedPath, `${generated}\nstale\n`)
    const stale = spawnSync(process.execPath, [scriptPath, '--check', '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(stale.status, 1)
    assert.match(
      stale.stdout,
      /repository map is stale: docs\/generated\/repository-map\.md; run --write/,
    )
  })
})

test('fails closed when a feature manifest or route registry is missing', async () => {
  await withFixture(
    {
      'src/app/main.ts': 'export const app = true\n',
      'src/shared/index.ts': 'export const shared = true\n',
      'src/features/chat/index.ts': 'export const ChatPage = () => null\n',
    },
    async (root) => {
      const result = spawnSync(process.execPath, [scriptPath, '--write', '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /repository map error: feature chat is missing module\.json/)
    },
  )
})

test('fails closed when the route registry itself is missing', async () => {
  const files = baseFiles()
  delete files['src/app/router/route-registry.tsx']
  await withFixture(files, async (root) => {
    const result = spawnSync(process.execPath, [scriptPath, '--write', '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    assert.match(
      result.stderr,
      /repository map error: missing route registry: src\/app\/router\/route-registry\.tsx/,
    )
  })
})

test('fails closed for malformed route entries', async () => {
  await withFixture(
    {
      ...baseFiles(),
      'src/app/router/route-registry.tsx': "export const APP_ROUTES = [{ path: '/' }]\n",
    },
    async (root) => {
      assert.throws(() => buildRepositoryMap(root), /route entry is missing label/)
    },
  )
})
