import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkBundle } from './check-bundle.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repositoryRoot, 'scripts/quality/check-bundle.mjs')

async function createFixture({ budget, manifest, assets }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bundle-budget-'))
  await writeFile(path.join(root, 'bundle-budget.json'), `${JSON.stringify(budget, null, 2)}\n`)
  const manifestPath = path.join(root, 'dist/.vite/manifest.json')
  await mkdir(path.dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [relative, bytes] of Object.entries(assets)) {
    const file = path.join(root, 'dist', relative)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.alloc(bytes, 0x61))
  }
  return root
}

async function withFixture(fixture, callback) {
  const root = await createFixture(fixture)
  try {
    return await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const passingBudget = {
  entryJsMaxBytes: 100,
  coldStartJsMaxBytes: 180,
  chunkJsMaxBytes: 100,
  totalJsMaxBytes: 180,
}

test('accepts manifest entries and imported chunks within all byte budgets', async () => {
  await withFixture(
    {
      budget: passingBudget,
      manifest: {
        'index.html': {
          file: 'assets/index.js',
          isEntry: true,
          imports: ['assets/async.js'],
        },
        'assets/async.js': {
          file: 'assets/async.js',
          isDynamicEntry: true,
        },
      },
      assets: {
        'assets/index.js': 80,
        'assets/async.js': 70,
      },
    },
    async (root) => {
      const result = checkBundle(root)
      assert.deepEqual(result.entryJs, ['dist/assets/index.js'])
      assert.deepEqual(result.jsAssets, [
        { path: 'dist/assets/async.js', bytes: 70 },
        { path: 'dist/assets/index.js', bytes: 80 },
      ])
      assert.equal(result.totalJsBytes, 150)
      assert.deepEqual(result.violations, [])
    },
  )
})

test('deduplicates manifest references when calculating total JavaScript bytes', async () => {
  await withFixture(
    {
      budget: {
        entryJsMaxBytes: 100,
        coldStartJsMaxBytes: 100,
        chunkJsMaxBytes: 100,
        totalJsMaxBytes: 100,
      },
      manifest: {
        'index.html': {
          file: 'assets/index.js',
          isEntry: true,
          imports: ['chunk.js'],
          dynamicImports: ['chunk.js'],
        },
        'chunk.js': { file: 'assets/chunk.js' },
      },
      assets: {
        'assets/index.js': 60,
        'assets/chunk.js': 40,
      },
    },
    async (root) => {
      const result = checkBundle(root)
      assert.equal(result.totalJsBytes, 100)
      assert.equal(result.jsAssets.length, 2)
      assert.deepEqual(result.violations, [])
    },
  )
})

test('reports deterministic entry, chunk, and total budget violations', async () => {
  await withFixture(
    {
      budget: {
        entryJsMaxBytes: 100,
        coldStartJsMaxBytes: 500,
        chunkJsMaxBytes: 90,
        totalJsMaxBytes: 150,
      },
      manifest: {
        'index.html': { file: 'assets/index.js', isEntry: true, imports: ['chunk.js'] },
        'chunk.js': { file: 'assets/chunk.js' },
      },
      assets: {
        'assets/index.js': 101,
        'assets/chunk.js': 100,
      },
    },
    async (root) => {
      const result = checkBundle(root)
      assert.deepEqual(
        result.violations.map((violation) => violation.code),
        ['total-js-too-large', 'js-chunk-too-large', 'entry-js-too-large', 'js-chunk-too-large'],
      )
      assert.deepEqual(
        result.violations.map((violation) => violation.file),
        [
          'dist/.vite/manifest.json',
          'dist/assets/chunk.js',
          'dist/assets/index.js',
          'dist/assets/index.js',
        ],
      )
      assert.match(
        result.violations.find((violation) => violation.code === 'js-chunk-too-large').message,
        /100 bytes exceeds chunk budget 90 bytes/,
      )
    },
  )
})

test('CLI passes and fails with stable exit codes, and fails closed on unsafe manifest paths', async () => {
  await withFixture(
    {
      budget: passingBudget,
      manifest: { 'index.html': { file: 'assets/index.js', isEntry: true } },
      assets: { 'assets/index.js': 20 },
    },
    async (root) => {
      const passing = spawnSync(process.execPath, [scriptPath, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(passing.status, 0)
      assert.match(
        passing.stdout,
        /bundle budget passed: 1 JavaScript assets, cold start 20 bytes, total 20 bytes/,
      )

      const unsafeManifest = {
        'index.html': { file: '../outside.js', isEntry: true },
      }
      await writeFile(
        path.join(root, 'dist/.vite/manifest.json'),
        `${JSON.stringify(unsafeManifest, null, 2)}\n`,
      )
      const failing = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' })
      assert.equal(failing.status, 2)
      assert.match(
        failing.stderr,
        /bundle budget error: manifest entry index\.html\.file must not contain '\.\.'/,
      )
    },
  )
})

test('fails closed when the manifest has no JavaScript entry', async () => {
  await withFixture(
    {
      budget: passingBudget,
      manifest: { 'index.html': { file: 'assets/index.css', isEntry: true } },
      assets: { 'assets/index.css': 20 },
    },
    async (root) => {
      assert.throws(() => checkBundle(root), /manifest contains no JavaScript entry/)
    },
  )
})

test('fails closed when manifest graph references an unknown entry', async () => {
  await withFixture(
    {
      budget: passingBudget,
      manifest: {
        'index.html': {
          file: 'assets/index.js',
          isEntry: true,
          imports: ['missing.js'],
        },
      },
      assets: { 'assets/index.js': 20 },
    },
    async (root) => {
      assert.throws(
        () => checkBundle(root),
        /manifest entry index\.html\.imports references unknown manifest entry: missing\.js/,
      )
    },
  )
})

test('counts a statically imported chunk against the cold-start budget', async () => {
  await withFixture(
    {
      budget: {
        entryJsMaxBytes: 100,
        coldStartJsMaxBytes: 120,
        chunkJsMaxBytes: 200,
        totalJsMaxBytes: 400,
      },
      manifest: {
        'index.html': {
          file: 'assets/index.js',
          isEntry: true,
          imports: ['assets/vendor.js'],
          dynamicImports: ['assets/route.js'],
        },
        'assets/vendor.js': { file: 'assets/vendor.js' },
        'assets/route.js': { file: 'assets/route.js', isDynamicEntry: true },
      },
      assets: {
        'assets/index.js': 90,
        'assets/vendor.js': 90,
        'assets/route.js': 150,
      },
    },
    (root) => {
      const result = checkBundle(root)
      assert.equal(result.coldStartBytes, 180)
      assert.deepEqual(
        result.violations.map((violation) => violation.code),
        ['cold-start-js-too-large'],
      )
    },
  )
})

test('leaves a lazily imported chunk out of the cold-start total', async () => {
  await withFixture(
    {
      budget: {
        entryJsMaxBytes: 100,
        coldStartJsMaxBytes: 100,
        chunkJsMaxBytes: 200,
        totalJsMaxBytes: 400,
      },
      manifest: {
        'index.html': {
          file: 'assets/index.js',
          isEntry: true,
          dynamicImports: ['assets/route.js'],
        },
        'assets/route.js': { file: 'assets/route.js', isDynamicEntry: true },
      },
      assets: {
        'assets/index.js': 90,
        'assets/route.js': 150,
      },
    },
    (root) => {
      const result = checkBundle(root)
      assert.equal(result.coldStartBytes, 90)
      assert.deepEqual(result.violations, [])
    },
  )
})
