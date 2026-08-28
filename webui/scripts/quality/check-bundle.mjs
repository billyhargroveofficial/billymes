#!/usr/bin/env node

import { lstatSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const BUDGET_FILE = 'bundle-budget.json'
const MANIFEST_FILE = 'dist/.vite/manifest.json'
const JS_FILE_PATTERN = /\.(?:js|mjs|cjs)$/i

class BundleBudgetError extends Error {}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function relativePath(root, file) {
  const relative = posixPath(path.relative(root, file))
  return relative || '.'
}

function isRegularFile(file) {
  try {
    return lstatSync(file).isFile()
  } catch {
    return false
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function readJson(file, label) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    throw new BundleBudgetError(`cannot read ${label}`)
  }
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new BundleBudgetError(
      `cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BundleBudgetError(`${name} must be a positive integer byte budget`)
  }
  return value
}

function loadBudget(root) {
  const file = path.join(root, BUDGET_FILE)
  if (!isRegularFile(file)) throw new BundleBudgetError(`missing ${BUDGET_FILE}`)
  const raw = readJson(file, BUDGET_FILE)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleBudgetError(`${BUDGET_FILE} must contain an object`)
  }
  return {
    entryJsMaxBytes: positiveInteger(raw.entryJsMaxBytes, 'entryJsMaxBytes'),
    coldStartJsMaxBytes: positiveInteger(raw.coldStartJsMaxBytes, 'coldStartJsMaxBytes'),
    chunkJsMaxBytes: positiveInteger(raw.chunkJsMaxBytes, 'chunkJsMaxBytes'),
    totalJsMaxBytes: positiveInteger(raw.totalJsMaxBytes, 'totalJsMaxBytes'),
  }
}

function safeAsset(root, distRoot, asset, context) {
  if (typeof asset !== 'string' || asset.trim() === '') {
    throw new BundleBudgetError(`${context} must reference a non-empty asset path`)
  }
  const normalizedAsset = asset.replaceAll('\\', '/')
  if (path.posix.isAbsolute(normalizedAsset) || path.win32.isAbsolute(asset)) {
    throw new BundleBudgetError(`${context} must stay inside dist: ${asset}`)
  }
  const parts = normalizedAsset.split('/')
  if (parts.includes('..'))
    throw new BundleBudgetError(`${context} must not contain '..': ${asset}`)
  const file = path.resolve(distRoot, ...parts)
  if (!isInside(distRoot, file))
    throw new BundleBudgetError(`${context} must stay inside dist: ${asset}`)
  if (!isRegularFile(file))
    throw new BundleBudgetError(`${context} is missing: ${relativePath(root, file)}`)
  let bytes
  try {
    bytes = statSync(file).size
  } catch {
    throw new BundleBudgetError(`${context} cannot be inspected: ${relativePath(root, file)}`)
  }
  return { file, path: relativePath(root, file), bytes }
}

function validateManifestEntry(key, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new BundleBudgetError(`manifest entry ${key} must contain an object`)
  }
  if (typeof entry.file !== 'string' || entry.file.trim() === '') {
    throw new BundleBudgetError(`manifest entry ${key} is missing file`)
  }
  for (const field of ['isEntry', 'isDynamicEntry']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'boolean') {
      throw new BundleBudgetError(`manifest entry ${key} ${field} must be a boolean`)
    }
  }
  for (const field of ['imports', 'dynamicImports', 'assets']) {
    if (
      entry[field] !== undefined &&
      (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== 'string'))
    ) {
      throw new BundleBudgetError(`manifest entry ${key} ${field} must be an array of strings`)
    }
  }
}

function collectManifestAssets(root, manifest, distRoot) {
  const entries = new Map()
  for (const key of Object.keys(manifest).sort(compareStrings)) {
    validateManifestEntry(key, manifest[key])
    entries.set(key, manifest[key])
  }

  const assets = new Map()
  const entryJs = new Set()
  const coldStartJs = new Set()
  const visitedEntries = new Set()

  const addAsset = (asset, context, isEntry = false) => {
    const resolved = safeAsset(root, distRoot, asset, context)
    if (!assets.has(resolved.path)) assets.set(resolved.path, resolved)
    if (isEntry && JS_FILE_PATTERN.test(resolved.path)) entryJs.add(resolved.path)
  }

  const visitEntry = (key, context) => {
    if (visitedEntries.has(key)) return
    const entry = entries.get(key)
    if (!entry) throw new BundleBudgetError(`${context} references unknown manifest entry: ${key}`)
    visitedEntries.add(key)
    addAsset(entry.file, `manifest entry ${key}.file`, Boolean(entry.isEntry))
    for (const asset of entry.assets ?? []) addAsset(asset, `manifest entry ${key}.assets`)
    for (const field of ['imports', 'dynamicImports']) {
      for (const importedKey of entry[field] ?? []) {
        if (!entries.has(importedKey)) {
          throw new BundleBudgetError(
            `manifest entry ${key}.${field} references unknown manifest entry: ${importedKey}`,
          )
        }
        visitEntry(importedKey, `manifest entry ${key}.${field}`)
      }
    }
  }

  for (const key of entries.keys()) visitEntry(key, 'manifest')

  // The cold-start graph is every entry plus its *static* import closure. A
  // chunk that a bundler split out is still downloaded before first paint when
  // the entry imports it statically, so the entry-chunk size alone does not
  // describe what a first visit costs.
  const visitedStatic = new Set()
  const visitStatic = (key) => {
    if (visitedStatic.has(key)) return
    visitedStatic.add(key)
    const entry = entries.get(key)
    if (!entry) return
    if (JS_FILE_PATTERN.test(entry.file))
      coldStartJs.add(relativePath(root, path.resolve(distRoot, entry.file)))
    for (const importedKey of entry.imports ?? []) visitStatic(importedKey)
  }
  for (const [key, entry] of entries) if (entry.isEntry) visitStatic(key)

  const jsAssets = [...assets.values()]
    .filter((asset) => JS_FILE_PATTERN.test(asset.path))
    .sort((left, right) => compareStrings(left.path, right.path))
  return {
    assets: [...assets.values()].sort((left, right) => compareStrings(left.path, right.path)),
    jsAssets,
    entryJs: [...entryJs].sort(compareStrings),
    coldStartJs: [...coldStartJs].sort(compareStrings),
  }
}

function makeViolation(code, file, message) {
  return { code, file, line: 1, message }
}

function checkBundle(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot)
  const budget = loadBudget(root)
  const manifestPath = path.join(root, MANIFEST_FILE)
  if (!isRegularFile(manifestPath)) throw new BundleBudgetError(`missing ${MANIFEST_FILE}`)
  const manifest = readJson(manifestPath, MANIFEST_FILE)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new BundleBudgetError(`${MANIFEST_FILE} must contain an object`)
  }
  const collected = collectManifestAssets(root, manifest, path.join(root, 'dist'))
  if (collected.entryJs.length === 0)
    throw new BundleBudgetError('manifest contains no JavaScript entry')

  const violations = []
  for (const asset of collected.jsAssets) {
    if (asset.bytes > budget.chunkJsMaxBytes) {
      violations.push(
        makeViolation(
          'js-chunk-too-large',
          asset.path,
          `${asset.bytes} bytes exceeds chunk budget ${budget.chunkJsMaxBytes} bytes`,
        ),
      )
    }
  }
  for (const entry of collected.entryJs) {
    const asset = collected.jsAssets.find((candidate) => candidate.path === entry)
    if (!asset) throw new BundleBudgetError(`entry asset is not a JavaScript file: ${entry}`)
    if (asset.bytes > budget.entryJsMaxBytes) {
      violations.push(
        makeViolation(
          'entry-js-too-large',
          asset.path,
          `${asset.bytes} bytes exceeds entry budget ${budget.entryJsMaxBytes} bytes`,
        ),
      )
    }
  }
  const coldStartBytes = collected.coldStartJs.reduce((total, file) => {
    const asset = collected.jsAssets.find((candidate) => candidate.path === file)
    return total + (asset ? asset.bytes : 0)
  }, 0)
  if (coldStartBytes > budget.coldStartJsMaxBytes) {
    violations.push(
      makeViolation(
        'cold-start-js-too-large',
        MANIFEST_FILE,
        `${coldStartBytes} bytes of eagerly imported JavaScript exceeds cold-start budget ${budget.coldStartJsMaxBytes} bytes`,
      ),
    )
  }
  const totalJsBytes = collected.jsAssets.reduce((total, asset) => total + asset.bytes, 0)
  if (totalJsBytes > budget.totalJsMaxBytes) {
    violations.push(
      makeViolation(
        'total-js-too-large',
        MANIFEST_FILE,
        `${totalJsBytes} bytes exceeds total JavaScript budget ${budget.totalJsMaxBytes} bytes`,
      ),
    )
  }
  violations.sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.message, right.message),
  )
  return {
    root,
    budget,
    manifestPath: MANIFEST_FILE,
    assets: collected.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
    jsAssets: collected.jsAssets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
    entryJs: collected.entryJs,
    coldStartJs: collected.coldStartJs,
    coldStartBytes,
    totalJsBytes,
    violations,
  }
}

function parseArguments(argumentsList) {
  let root = process.cwd()
  let rootProvided = false
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--root') {
      const value = argumentsList[index + 1]
      if (!value) throw new Error('--root requires a repository path')
      if (rootProvided) throw new Error('only one repository path may be provided')
      root = value
      rootProvided = true
      index += 1
      continue
    }
    if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    if (rootProvided) throw new Error('only one repository path may be provided')
    root = argument
    rootProvided = true
  }
  return { root }
}

function formatBytes(bytes) {
  return `${bytes} bytes`
}

function usage() {
  return [
    'Usage: node scripts/quality/check-bundle.mjs [--root <repository>]',
    '',
    `Reads ${BUDGET_FILE} and ${MANIFEST_FILE}, then checks JavaScript byte budgets.`,
    'Exit codes: 0 = pass, 1 = budget violations, 2 = configuration/manifest error.',
  ].join('\n')
}

export { checkBundle }

export function main(argumentsList = process.argv.slice(2), output = console) {
  try {
    const argumentsValue = parseArguments(argumentsList)
    if (argumentsValue.help) {
      output.log(usage())
      return 0
    }
    const result = checkBundle(argumentsValue.root)
    if (result.violations.length === 0) {
      output.log(
        `bundle budget passed: ${result.jsAssets.length} JavaScript assets, ` +
          `cold start ${formatBytes(result.coldStartBytes)}, total ${formatBytes(result.totalJsBytes)}`,
      )
      return 0
    }
    for (const violation of result.violations) {
      output.log(`${violation.file}:${violation.line} [${violation.code}] ${violation.message}`)
    }
    output.log(`bundle budget failed: ${result.violations.length} violation(s)`)
    return 1
  } catch (error) {
    output.error(`bundle budget error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedFile === import.meta.url) process.exitCode = main()
