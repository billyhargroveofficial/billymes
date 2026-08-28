import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkArchitecture, formatViolation } from './check-architecture.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const checkerPath = path.join(repositoryRoot, 'scripts/quality/check-architecture.mjs')
const config = {
  sourceRoot: 'src',
  allowedRoots: ['app', 'features', 'shared'],
  legacyRoots: ['lib', 'components', 'pages', 'App.tsx'],
  featureRoot: 'features',
  featureManifest: 'module.json',
  publicEntry: 'index.ts',
  alias: '@/',
  sourceExtensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  sizeExtensions: ['.ts', '.tsx'],
  serverRoot: 'server',
  serverSizeExtensions: ['.ts', '.tsx'],
  maxProductionFileLines: 450,
  sizeExcludedPatterns: [
    '(^|/)(__tests__|tests?)(/|$)',
    '(^|/)generated(/|$)',
    '(^|/)generated\\.[cm]?[jt]sx?$',
    '\\.(test|spec|stories|generated)\\.[cm]?[jt]sx?$',
    '\\.d\\.ts$',
  ],
  excludedDirectories: ['node_modules', 'dist'],
}

function manifest(id, dependencies = []) {
  return `${JSON.stringify({ id, dependencies }, null, 2)}\n`
}

function numberedLines(count) {
  return Array.from(
    { length: count },
    (_, index) => `export const generatedLine${index} = ${index}`,
  ).join('\n')
}

async function createFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'architecture-gate-'))
  await writeFile(path.join(root, 'architecture.json'), `${JSON.stringify(config, null, 2)}\n`)
  await mkdir(path.join(root, config.serverRoot), { recursive: true })
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, contents)
  }
  return root
}

async function withFixture(files, callback) {
  const root = await createFixture(files)
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function codes(result) {
  return result.violations.map((violation) => violation.code)
}

function findViolation(result, code, file) {
  return result.violations.find((violation) => violation.code === code && violation.file === file)
}

test('passes target layers, public entries, declared dependencies, and ignores comments', async () => {
  await withFixture(
    {
      'src/app/main.ts': [
        "import { chat } from '@/features/chat'",
        "import { shared } from '@/shared/index'",
        "export { chat } from '@/features/chat'",
        "void import('@/features/chat')",
        'const text = "import \'@/features/ghost\'"',
        "// import '@/features/ghost'",
        'export { shared }',
      ].join('\n'),
      'src/shared/index.ts': 'export const shared = 1\n',
      'src/features/chat/module.json': manifest('chat', ['profiles']),
      'src/features/chat/index.ts': [
        "import { profile } from '@/features/profiles'",
        'export const chat = profile',
      ].join('\n'),
      'src/features/profiles/module.json': manifest('profiles'),
      'src/features/profiles/index.ts': 'export const profile = 1\n',
    },
    async (root) => {
      const result = checkArchitecture(root)
      assert.deepEqual(result.violations, [])
      assert.deepEqual(result.featureIds, ['chat', 'profiles'])
      assert.equal(result.stats.features, 2)
      assert.ok(result.files.includes('src/app/main.ts'))
    },
  )
})

test('reports exact structural, layer, public-api, and dependency violations', async () => {
  await withFixture(
    {
      'src/app/main.ts': [
        "import privateChat from '@/features/chat/private'",
        "import relativeChat from '../features/chat/index'",
        "import missing from '@/features/missing'",
        'export { privateChat, relativeChat, missing }',
      ].join('\n'),
      'src/shared/bad.ts': "import '@/features/chat'\n",
      'src/features/chat/module.json': manifest('chat'),
      'src/features/chat/index.ts': ["import '@/app/main'", "import '../profiles/index'"].join(
        '\n',
      ),
      'src/features/profiles/index.ts': 'export const profile = 1\n',
      'src/features/broken/module.json': 'null\n',
      'src/features/broken/view.ts': 'export const broken = true\n',
      'src/lib/legacy.ts': 'export const legacy = true\n',
      'src/components/legacy.ts': 'export const legacyComponent = true\n',
      'src/pages/legacy.ts': 'export const legacyPage = true\n',
      'src/App.tsx': 'export const LegacyApp = () => null\n',
      'src/main.tsx': 'export const oldEntry = true\n',
    },
    async (root) => {
      const result = checkArchitecture(root)
      const resultCodes = codes(result)
      for (const code of [
        'legacy-root',
        'source-outside-layer',
        'missing-feature-manifest',
        'missing-public-entry',
        'invalid-module-manifest',
        'forbidden-layer-import',
        'cross-feature-import',
        'undeclared-feature-dependency',
        'feature-public-api',
        'unknown-feature-import',
      ]) {
        assert.ok(resultCodes.includes(code), `expected ${code} in ${resultCodes.join(', ')}`)
      }

      assert.equal(findViolation(result, 'source-outside-layer', 'src/main.tsx')?.line, 1)
      assert.equal(
        findViolation(result, 'forbidden-layer-import', 'src/features/chat/index.ts')?.line,
        1,
      )
      assert.equal(
        findViolation(result, 'cross-feature-import', 'src/features/chat/index.ts')?.line,
        2,
      )
      assert.match(
        formatViolation(
          findViolation(result, 'cross-feature-import', 'src/features/chat/index.ts'),
        ),
        /^src\/features\/chat\/index\.ts:2 \[cross-feature-import\]/,
      )
      assert.equal(
        result.violations.filter((violation) => violation.code === 'legacy-root').length,
        4,
      )
    },
  )
})

test('scans untracked fixture files, excludes node_modules/dist, and enforces production size', async () => {
  await withFixture(
    {
      'src/app/index.ts': 'export const app = true\n',
      'src/app/large.ts': numberedLines(451),
      'src/app/large.test.ts': numberedLines(700),
      'src/shared/index.ts': 'export const shared = true\n',
      'src/shared/generated/large.ts': numberedLines(700),
      'src/shared/generated.ts': numberedLines(700),
      'src/shared/__tests__/large.ts': numberedLines(700),
      'src/node_modules/ignored.ts': numberedLines(900),
      'src/dist/ignored.ts': numberedLines(900),
      'src/features/example/module.json': manifest('example'),
      'src/features/example/index.ts': 'export const example = true\n',
    },
    async (root) => {
      const result = checkArchitecture(root)
      const oversized = result.violations.filter(
        (violation) => violation.code === 'production-file-too-large',
      )
      assert.deepEqual(
        oversized.map((violation) => violation.file),
        ['src/app/large.ts'],
      )
      assert.ok(result.files.includes('src/app/large.test.ts'))
      assert.ok(!result.files.some((file) => file.includes('/node_modules/')))
      assert.ok(!result.files.some((file) => file.includes('/dist/')))
    },
  )
})

test('enforces the production size limit for server TypeScript and excludes server tests', async () => {
  await withFixture(
    {
      'src/app/index.ts': 'export const app = true\n',
      'src/shared/index.ts': 'export const shared = true\n',
      'src/features/example/module.json': manifest('example'),
      'src/features/example/index.ts': 'export const example = true\n',
      'server/large.ts': numberedLines(451),
      'server/gateway-proxy.test.ts': numberedLines(700),
      'server/generated/large.ts': numberedLines(700),
      'server/node_modules/ignored.ts': numberedLines(900),
    },
    async (root) => {
      const result = checkArchitecture(root)
      const oversized = result.violations.filter(
        (violation) => violation.code === 'production-file-too-large',
      )
      assert.deepEqual(
        oversized.map((violation) => violation.file),
        ['server/large.ts'],
      )
      assert.deepEqual(result.serverFiles, [
        'server/gateway-proxy.test.ts',
        'server/generated/large.ts',
        'server/large.ts',
      ])
      assert.equal(result.stats.serverFilesScanned, 3)
    },
  )
})

test('fails closed when the server size contract is missing or malformed', async () => {
  await withFixture(
    {
      'src/app/index.ts': 'export const app = true\n',
      'src/shared/index.ts': 'export const shared = true\n',
      'src/features/example/module.json': manifest('example'),
      'src/features/example/index.ts': 'export const example = true\n',
    },
    async (root) => {
      const architecturePath = path.join(root, 'architecture.json')
      const current = JSON.parse(await readFile(architecturePath, 'utf8'))
      const invalidConfigs = [
        { name: 'missing serverRoot', config: { ...current, serverRoot: undefined } },
        { name: 'absolute serverRoot', config: { ...current, serverRoot: '/server' } },
        {
          name: 'empty serverSizeExtensions',
          config: { ...current, serverSizeExtensions: [] },
        },
        {
          name: 'non-string serverSizeExtensions',
          config: { ...current, serverSizeExtensions: ['.ts', 42] },
        },
      ]
      for (const invalid of invalidConfigs) {
        await writeFile(architecturePath, `${JSON.stringify(invalid.config)}\n`)
        assert.throws(
          () => checkArchitecture(root),
          /serverRoot|serverSizeExtensions/,
          invalid.name,
        )
      }

      await writeFile(architecturePath, `${JSON.stringify(current)}\n`)
      await rm(path.join(root, current.serverRoot), { recursive: true, force: true })
      const missingServer = checkArchitecture(root)
      assert.ok(
        missingServer.violations.some((violation) => violation.code === 'missing-server-root'),
      )
    },
  )
})

test('CLI returns deterministic pass/fail exit codes for temporary fixtures', async () => {
  await withFixture(
    {
      'src/app/main.ts': "import { feature } from '@/features/example'\nexport { feature }\n",
      'src/shared/index.ts': 'export const shared = true\n',
      'src/features/example/module.json': manifest('example'),
      'src/features/example/index.ts': 'export const feature = true\n',
    },
    async (root) => {
      const help = spawnSync(process.execPath, [checkerPath, '--help'], { encoding: 'utf8' })
      assert.equal(help.status, 0)
      assert.match(help.stdout, /Usage: node scripts\/quality\/check-architecture\.mjs/)

      const passing = spawnSync(process.execPath, [checkerPath, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(passing.status, 0)
      assert.match(passing.stdout, /architecture gate passed: \d+ source files, 1 features/)

      const oversized = path.join(root, 'src/app/too-large.ts')
      await writeFile(oversized, numberedLines(451))
      const failing = spawnSync(process.execPath, [checkerPath, root], { encoding: 'utf8' })
      assert.equal(failing.status, 1)
      assert.match(failing.stdout, /src\/app\/too-large\.ts:1 \[production-file-too-large\]/)
      assert.match(failing.stdout, /architecture gate failed: 1 violation\(s\)/)
    },
  )
})

test('fails closed when architecture configuration is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'architecture-gate-missing-config-'))
  try {
    const output = spawnSync(process.execPath, [checkerPath, root], { encoding: 'utf8' })
    assert.equal(output.status, 2)
    assert.match(output.stderr, /architecture gate error: missing architecture\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fixture helper itself does not depend on repository state', async () => {
  const root = await createFixture({ 'src/shared/index.ts': 'export const value = 1\n' })
  try {
    const architecture = JSON.parse(await readFile(path.join(root, 'architecture.json'), 'utf8'))
    assert.deepEqual(architecture.allowedRoots, ['app', 'features', 'shared'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
