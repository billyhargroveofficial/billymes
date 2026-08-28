#!/usr/bin/env node

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ARCHITECTURE_FILE = 'architecture.json'
const DEFAULT_ROUTE_REGISTRY = 'app/router/route-registry.tsx'
const MAP_FILE = 'docs/generated/repository-map.md'
const FEATURE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

class RepositoryMapError extends Error {}

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

function isDirectory(directory) {
  try {
    return lstatSync(directory).isDirectory()
  } catch {
    return false
  }
}

function normalizeRelative(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RepositoryMapError(`${name} must be a non-empty relative path`)
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new RepositoryMapError(`${name} must be relative: ${value}`)
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new RepositoryMapError(`${name} cannot contain '..': ${value}`)
  }
  const normalized = posixPath(path.posix.normalize(value))
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    throw new RepositoryMapError(`${name} must stay inside the repository: ${value}`)
  }
  return normalized
}

function readText(file, label) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new RepositoryMapError(`cannot read ${label}`)
  }
}

function readJson(file, label) {
  const source = readText(file, label)
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new RepositoryMapError(
      `cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function loadArchitecture(root) {
  const file = path.join(root, ARCHITECTURE_FILE)
  if (!isRegularFile(file)) throw new RepositoryMapError(`missing ${ARCHITECTURE_FILE}`)
  const raw = readJson(file, ARCHITECTURE_FILE)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RepositoryMapError(`${ARCHITECTURE_FILE} must contain an object`)
  }

  const sourceRoot = normalizeRelative(raw.sourceRoot, 'sourceRoot')
  if (!Array.isArray(raw.allowedRoots) || raw.allowedRoots.length === 0) {
    throw new RepositoryMapError('allowedRoots must be a non-empty array')
  }
  const allowedRoots = raw.allowedRoots.map((value) =>
    normalizeRelative(value, 'allowedRoots entry'),
  )
  const featureRoot = normalizeRelative(raw.featureRoot, 'featureRoot')
  if (!allowedRoots.includes(featureRoot)) {
    throw new RepositoryMapError('featureRoot must be one of allowedRoots')
  }
  const featureManifest = normalizeRelative(raw.featureManifest, 'featureManifest')
  const publicEntry = normalizeRelative(raw.publicEntry, 'publicEntry')
  if (featureManifest.includes('/') || publicEntry.includes('/')) {
    throw new RepositoryMapError('featureManifest and publicEntry must be direct feature files')
  }
  if (typeof raw.alias !== 'string' || raw.alias.trim() === '') {
    throw new RepositoryMapError('alias must be a non-empty string')
  }
  if (!Number.isInteger(raw.maxProductionFileLines) || raw.maxProductionFileLines <= 0) {
    throw new RepositoryMapError('maxProductionFileLines must be a positive integer')
  }
  if (!Array.isArray(raw.excludedDirectories) || raw.excludedDirectories.length === 0) {
    throw new RepositoryMapError('excludedDirectories must be a non-empty array')
  }
  const excludedDirectories = raw.excludedDirectories.map((value) => {
    if (typeof value !== 'string' || value === '' || value.includes('/') || value.includes('\\')) {
      throw new RepositoryMapError('excludedDirectories must contain directory names')
    }
    return value
  })
  const routeRegistry = raw.routeRegistry
    ? normalizeRelative(raw.routeRegistry, 'routeRegistry')
    : DEFAULT_ROUTE_REGISTRY
  if (routeRegistry !== 'app' && !routeRegistry.startsWith('app/')) {
    throw new RepositoryMapError('routeRegistry must be inside app')
  }

  return {
    sourceRoot,
    allowedRoots,
    featureRoot,
    featureManifest,
    publicEntry,
    alias: raw.alias.endsWith('/') ? raw.alias : `${raw.alias}/`,
    maxProductionFileLines: raw.maxProductionFileLines,
    excludedDirectories: new Set(excludedDirectories),
    routeRegistry,
  }
}

function walkFiles(directory, excludedDirectories, files = [], repositoryRoot = directory) {
  if (!isDirectory(directory)) return files
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    )
  } catch {
    throw new RepositoryMapError(
      `cannot read source directory: ${relativePath(repositoryRoot, directory)}`,
    )
  }
  for (const entry of entries) {
    if (excludedDirectories.has(entry.name)) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walkFiles(file, excludedDirectories, files, repositoryRoot)
    else if (entry.isFile()) files.push(file)
    else if (entry.isSymbolicLink()) {
      throw new RepositoryMapError(
        `symbolic link is not supported in source tree: ${relativePath(repositoryRoot, file)}`,
      )
    } else {
      throw new RepositoryMapError(
        `unsupported filesystem entry in source tree: ${relativePath(repositoryRoot, file)}`,
      )
    }
  }
  return files
}

function readFeatures(root, architecture) {
  const sourceRoot = path.join(root, architecture.sourceRoot)
  const featureRoot = path.join(sourceRoot, architecture.featureRoot)
  const featureRootLabel = `${architecture.sourceRoot}/${architecture.featureRoot}`
  if (!isDirectory(featureRoot)) throw new RepositoryMapError(`missing ${featureRootLabel}`)

  let entries
  try {
    entries = readdirSync(featureRoot, { withFileTypes: true })
      .filter((entry) => !architecture.excludedDirectories.has(entry.name))
      .sort((left, right) => compareStrings(left.name, right.name))
  } catch {
    throw new RepositoryMapError(`cannot read feature root: ${relativePath(root, featureRoot)}`)
  }
  const features = []
  for (const entry of entries) {
    const featurePath = path.join(featureRoot, entry.name)
    if (!entry.isDirectory()) {
      throw new RepositoryMapError(
        `feature root contains a non-directory: ${featureRootLabel}/${entry.name}`,
      )
    }
    if (!FEATURE_ID_PATTERN.test(entry.name)) {
      throw new RepositoryMapError(`invalid feature id: ${entry.name}`)
    }

    const manifestPath = path.join(featurePath, architecture.featureManifest)
    const publicEntryPath = path.join(featurePath, architecture.publicEntry)
    const featureLabel = `${featureRootLabel}/${entry.name}`
    if (!isRegularFile(manifestPath)) {
      throw new RepositoryMapError(
        `feature ${entry.name} is missing ${architecture.featureManifest}`,
      )
    }
    if (!isRegularFile(publicEntryPath)) {
      throw new RepositoryMapError(`feature ${entry.name} is missing ${architecture.publicEntry}`)
    }

    const manifest = readJson(manifestPath, `${featureLabel}/${architecture.featureManifest}`)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new RepositoryMapError(`feature ${entry.name} module.json must contain an object`)
    }
    if (manifest.id !== entry.name) {
      throw new RepositoryMapError(`feature ${entry.name} module.json id must equal ${entry.name}`)
    }
    if (
      !Array.isArray(manifest.dependencies) ||
      manifest.dependencies.some((dependency) => typeof dependency !== 'string')
    ) {
      throw new RepositoryMapError(
        `feature ${entry.name} module.json dependencies must be an array of ids`,
      )
    }
    if (new Set(manifest.dependencies).size !== manifest.dependencies.length) {
      throw new RepositoryMapError(
        `feature ${entry.name} module.json contains duplicate dependencies`,
      )
    }
    const dependencies = [...manifest.dependencies]
    if (dependencies.some((dependency) => !FEATURE_ID_PATTERN.test(dependency))) {
      throw new RepositoryMapError(
        `feature ${entry.name} module.json contains an invalid dependency id`,
      )
    }
    if (dependencies.includes(entry.name)) {
      throw new RepositoryMapError(`feature ${entry.name} cannot depend on itself`)
    }

    const publicSource = readText(publicEntryPath, `${featureLabel}/${architecture.publicEntry}`)
    const publicExports = extractPublicExports(publicSource)
    const files = walkFiles(featurePath, architecture.excludedDirectories, [], root)
    features.push({
      id: entry.name,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      dependencies: dependencies.sort(compareStrings),
      publicExports,
      files: files.length,
      manifestPath: relativePath(root, manifestPath),
      publicEntryPath: relativePath(root, publicEntryPath),
    })
  }

  const featureIds = new Set(features.map((feature) => feature.id))
  for (const feature of features) {
    for (const dependency of feature.dependencies) {
      if (!featureIds.has(dependency)) {
        throw new RepositoryMapError(
          `feature ${feature.id} declares unknown dependency ${dependency}`,
        )
      }
    }
  }
  return features
}

function maskNonCode(source, context = 'feature public entry') {
  const output = source.split('')
  const preserveNewline = (index) => {
    if (source[index] === '\r' && source[index + 1] === '\n') output[index + 1] = '\n'
    return source[index] === '\n' || source[index] === '\r'
  }

  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (character !== '/' && character !== '"' && character !== "'" && character !== '`') {
      index += 1
      continue
    }

    if (character === '/' && source[index + 1] === '/') {
      output[index] = ' '
      output[index + 1] = ' '
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        output[index] = ' '
        index += 1
      }
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      output[index] = ' '
      output[index + 1] = ' '
      index += 2
      let closed = false
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          output[index] = ' '
          output[index + 1] = ' '
          index += 2
          closed = true
          break
        }
        if (!preserveNewline(index)) output[index] = ' '
        index += 1
      }
      if (!closed) throw new RepositoryMapError(`unterminated comment in ${context}`)
      continue
    }

    const quote = character
    output[index] = ' '
    index += 1
    let closed = false
    while (index < source.length) {
      if (source[index] === '\\') {
        output[index] = ' '
        if (index + 1 < source.length) {
          if (!preserveNewline(index + 1)) output[index + 1] = ' '
          index += 2
        } else {
          index += 1
        }
        continue
      }
      if (source[index] === quote) {
        output[index] = ' '
        index += 1
        closed = true
        break
      }
      if (!preserveNewline(index)) output[index] = ' '
      index += 1
    }
    if (!closed) throw new RepositoryMapError(`unterminated string in ${context}`)
  }
  return output.join('')
}

function extractPublicExports(source) {
  const code = maskNonCode(source)
  const exports = new Set()
  const namedExport = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}/g
  for (const match of code.matchAll(namedExport)) {
    for (const item of match[1].split(',')) {
      const name = item
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exports.add(name)
    }
  }
  const declarationExport =
    /\bexport\s+(?:(?:declare|abstract|async)\s+)*(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g
  for (const match of code.matchAll(declarationExport)) exports.add(match[1])
  if (/\bexport\s+default\b/.test(code)) exports.add('default')
  return [...exports].sort(compareStrings)
}

function readQuoted(text, quoteIndex) {
  const quote = text[quoteIndex]
  let value = ''
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      const next = text[index + 1]
      if (next !== undefined) value += next
      index += 1
      continue
    }
    if (character === quote) return { value, end: index + 1 }
    value += character
  }
  throw new RepositoryMapError('unterminated string in route registry')
}

function extractBalanced(text, openingIndex, opening, closing) {
  let depth = 0
  let index = openingIndex
  while (index < text.length) {
    const character = text[index]
    if (character === "'" || character === '"' || character === '`') {
      index = readQuoted(text, index).end
      continue
    }
    if (character === '/' && text[index + 1] === '/') {
      index += 2
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) throw new RepositoryMapError('unterminated comment in route registry')
      index = end + 2
      continue
    }
    if (character === opening) depth += 1
    if (character === closing) {
      depth -= 1
      if (depth === 0) return { content: text.slice(openingIndex, index + 1), end: index + 1 }
    }
    index += 1
  }
  throw new RepositoryMapError(`unterminated ${opening}${closing} block in route registry`)
}

function findRouteArray(source) {
  const code = maskNonCode(source, 'route registry')
  const marker = /\bexport\s+(?:const|let|var)\s+APP_ROUTES\b[\s\S]*?=\s*/m.exec(code)
  if (!marker) throw new RepositoryMapError('route registry does not export APP_ROUTES')
  const openingIndex = source.indexOf('[', marker.index + marker[0].length)
  if (openingIndex === -1) throw new RepositoryMapError('APP_ROUTES must be an array')
  return extractBalanced(source, openingIndex, '[', ']').content
}

function skipIgnorable(text, start, context) {
  let index = start
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index += 1
      continue
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1
      continue
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) throw new RepositoryMapError(`unterminated comment in ${context}`)
      index = end + 2
      continue
    }
    break
  }
  return index
}

function topLevelObjects(arraySource) {
  const objects = []
  let index = 1
  while (index < arraySource.length - 1) {
    index = skipIgnorable(arraySource, index, 'APP_ROUTES')
    if (index >= arraySource.length - 1 || arraySource[index] === ']') break
    if (arraySource[index] !== '{') {
      throw new RepositoryMapError('APP_ROUTES entries must be object literals')
    }
    const object = extractBalanced(arraySource, index, '{', '}')
    objects.push(object.content)
    index = skipIgnorable(arraySource, object.end, 'APP_ROUTES')
    if (arraySource[index] === ',') {
      index += 1
      continue
    }
    if (arraySource[index] === ']') break
    throw new RepositoryMapError('APP_ROUTES entries must be comma-separated')
  }
  return objects
}

function parseStringField(object, field) {
  const match = new RegExp(`\\b${field}\\s*:\\s*(['"])`).exec(object)
  if (!match) throw new RepositoryMapError(`route entry is missing ${field}`)
  return readQuoted(object, match.index + match[0].length - 1).value
}

function parseIdentifierField(object, field) {
  const match = new RegExp(`\\b${field}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(object)
  if (!match) throw new RepositoryMapError(`route entry is missing ${field}`)
  return match[1]
}

function featureImportMap(source, alias) {
  const map = new Map()
  const aliasPattern = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const named = new RegExp(
    `\\bimport\\s*\\{([^{}]*?)\\}\\s*from\\s*(['"])${aliasPattern}features/([^/'"\\n]+)\\2`,
    'g',
  )
  for (const match of source.matchAll(named)) {
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/)
      const local = parts.at(-1)?.trim()
      if (local) map.set(local, match[3])
    }
  }
  const defaults = new RegExp(
    `\\bimport\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*(['"])${aliasPattern}features/([^/'"\\n]+)\\2`,
    'g',
  )
  for (const match of source.matchAll(defaults)) map.set(match[1], match[3])

  const lazy = new RegExp(
    `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*lazy\\([\\s\\S]*?\\bimport\\s*\\(\\s*(['"])${aliasPattern}features/([^/'"\\n]+)\\2`,
    'g',
  )
  for (const match of source.matchAll(lazy)) map.set(match[1], match[3])
  return map
}

function parseRoutes(root, architecture) {
  const sourceRoot = path.join(root, architecture.sourceRoot)
  const registryPath = path.join(sourceRoot, architecture.routeRegistry)
  if (!isRegularFile(registryPath)) {
    throw new RepositoryMapError(
      `missing route registry: ${architecture.sourceRoot}/${architecture.routeRegistry}`,
    )
  }
  const source = readText(registryPath, `${architecture.sourceRoot}/${architecture.routeRegistry}`)
  const routeArray = findRouteArray(source)
  const objects = topLevelObjects(routeArray)
  if (objects.length === 0)
    throw new RepositoryMapError('APP_ROUTES must contain at least one route')
  const imports = featureImportMap(source, architecture.alias)
  const paths = new Set()
  const routes = objects.map((object) => {
    const route = {
      path: parseStringField(object, 'path'),
      label: parseStringField(object, 'label'),
      page: parseIdentifierField(object, 'page'),
    }
    if (!route.path.startsWith('/'))
      throw new RepositoryMapError(`route path must start with '/': ${route.path}`)
    if (paths.has(route.path)) throw new RepositoryMapError(`duplicate route path: ${route.path}`)
    paths.add(route.path)
    route.feature = imports.get(route.page) ?? null
    return route
  })
  return { path: relativePath(root, registryPath), routes }
}

function markdownText(value, root) {
  return String(value)
    .replaceAll(path.resolve(root), '<repo>')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .trim()
}

function codeList(values) {
  return values.length ? values.map((value) => `\`${value}\``).join(', ') : '—'
}

function markdownTable(headers, rows) {
  const allRows = [headers, ...rows]
  const widths = headers.map((_, column) => Math.max(...allRows.map((row) => row[column].length)))
  const renderRow = (row) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ]
}

export function buildRepositoryMap(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot)
  const architecture = loadArchitecture(root)
  const sourceRoot = path.join(root, architecture.sourceRoot)
  if (!isDirectory(sourceRoot))
    throw new RepositoryMapError(`missing source root: ${architecture.sourceRoot}`)
  for (const allowedRoot of architecture.allowedRoots) {
    if (!isDirectory(path.join(sourceRoot, allowedRoot))) {
      throw new RepositoryMapError(
        `missing architecture layer: ${architecture.sourceRoot}/${allowedRoot}`,
      )
    }
  }

  const features = readFeatures(root, architecture)
  const routeRegistry = parseRoutes(root, architecture)
  const appFiles = walkFiles(
    path.join(sourceRoot, 'app'),
    architecture.excludedDirectories,
    [],
    root,
  )
  const sharedFiles = walkFiles(
    path.join(sourceRoot, 'shared'),
    architecture.excludedDirectories,
    [],
    root,
  )
  const mapLines = [
    '# Repository map',
    '',
    'Generated from the checked-in architecture contract and source registries.',
    '',
    '## Architecture',
    '',
    `- Source root: \`${architecture.sourceRoot}\``,
    `- Layers: ${architecture.allowedRoots.map((rootName) => `\`${architecture.sourceRoot}/${rootName}\``).join(', ')}`,
    `- Feature contract: \`${architecture.featureManifest}\` + \`${architecture.publicEntry}\``,
    `- Import alias: \`${architecture.alias}\``,
    `- Production TypeScript limit: ${architecture.maxProductionFileLines} lines`,
    '',
    '## App routes',
    '',
    `Registry: \`${routeRegistry.path}\``,
    '',
    ...markdownTable(
      ['Path', 'Label', 'Page', 'Feature'],
      routeRegistry.routes.map((route) => [
        `\`${markdownText(route.path, root)}\``,
        markdownText(route.label, root),
        `\`${markdownText(route.page, root)}\``,
        route.feature ? `\`${markdownText(route.feature, root)}\`` : '—',
      ]),
    ),
  ]

  mapLines.push('', '## Features', '')
  for (const feature of features) {
    mapLines.push(
      `### \`${feature.id}\``,
      '',
      `- Description: ${feature.description ? markdownText(feature.description, root) : '—'}`,
      `- Module: \`${feature.manifestPath}\``,
      `- Public entry: \`${feature.publicEntryPath}\``,
      `- Dependencies: ${codeList(feature.dependencies)}`,
      `- Public exports: ${codeList(feature.publicExports)}`,
      `- Source files: ${feature.files}`,
      '',
    )
  }

  mapLines.push(
    '## Shared',
    '',
    `- Source files: ${sharedFiles.length}`,
    '',
    '## App implementation',
    '',
    `- Source files: ${appFiles.length}`,
  )
  return {
    content: `${mapLines.join('\n')}\n`,
    mapPath: path.join(root, MAP_FILE),
    relativeMapPath: MAP_FILE,
    features,
    routes: routeRegistry.routes,
  }
}

function parseArguments(argumentsList) {
  let mode = null
  let root = process.cwd()
  let rootProvided = false
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--write' || argument === '--check') {
      if (mode) throw new Error('choose exactly one of --write or --check')
      mode = argument.slice(2)
      continue
    }
    if (argument === '--root') {
      const value = argumentsList[index + 1]
      if (!value) throw new Error('--root requires a repository path')
      if (rootProvided) throw new Error('only one repository path may be provided')
      root = value
      rootProvided = true
      index += 1
      continue
    }
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    if (rootProvided) throw new Error('only one repository path may be provided')
    root = argument
    rootProvided = true
  }
  if (!mode) throw new Error('one of --write or --check is required')
  return { mode, root }
}

function usage() {
  return [
    'Usage: node scripts/quality/repository-map.mjs --write|--check [--root <repository>]',
    '',
    `Reads ${ARCHITECTURE_FILE}, feature manifests, public entries, and the app route registry.`,
    `The generated artifact is ${MAP_FILE}.`,
    'Exit codes: 0 = pass, 1 = stale map, 2 = configuration/source/CLI error.',
  ].join('\n')
}

export function main(argumentsList = process.argv.slice(2), output = console) {
  try {
    const argumentsValue = parseArguments(argumentsList)
    if (argumentsValue.help) {
      output.log(usage())
      return 0
    }
    const root = path.resolve(argumentsValue.root)
    const result = buildRepositoryMap(root)
    if (argumentsValue.mode === 'write') {
      try {
        mkdirSync(path.dirname(result.mapPath), { recursive: true })
      } catch {
        throw new RepositoryMapError(`cannot create directory for ${result.relativeMapPath}`)
      }
      let current = null
      if (isRegularFile(result.mapPath)) {
        try {
          current = readFileSync(result.mapPath, 'utf8')
        } catch {
          throw new RepositoryMapError(`cannot read ${result.relativeMapPath}`)
        }
      }
      if (current !== result.content) {
        try {
          writeFileSync(result.mapPath, result.content)
        } catch {
          throw new RepositoryMapError(`cannot write ${result.relativeMapPath}`)
        }
      }
      output.log(`repository map written: ${result.relativeMapPath}`)
      return 0
    }
    if (!isRegularFile(result.mapPath)) {
      output.log(`repository map is missing: ${result.relativeMapPath}`)
      return 1
    }
    let current
    try {
      current = readFileSync(result.mapPath, 'utf8')
    } catch {
      throw new RepositoryMapError(`cannot read ${result.relativeMapPath}`)
    }
    if (current !== result.content) {
      output.log(`repository map is stale: ${result.relativeMapPath}; run --write`)
      return 1
    }
    output.log(`repository map is up to date: ${result.relativeMapPath}`)
    return 0
  } catch (error) {
    output.error(`repository map error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedFile === import.meta.url) process.exitCode = main()
