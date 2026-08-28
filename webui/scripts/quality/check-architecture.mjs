#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_FILE = 'architecture.json'
const FEATURE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

class ArchitectureConfigError extends Error {}

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function relativePath(root, file) {
  const relative = posixPath(path.relative(root, file))
  return relative || '.'
}

function normalizeRelative(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArchitectureConfigError(`${name} must be a non-empty relative path`)
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new ArchitectureConfigError(`${name} must be relative: ${value}`)
  }
  const parts = value.split(/[\\/]/)
  if (parts.includes('..')) {
    throw new ArchitectureConfigError(`${name} cannot contain '..': ${value}`)
  }
  const normalized = posixPath(path.posix.normalize(value))
  if (normalized === '.' || normalized.startsWith('../')) {
    throw new ArchitectureConfigError(`${name} must stay inside the source root: ${value}`)
  }
  return normalized
}

function normalizeExtensionList(value, name) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new ArchitectureConfigError(`${name} must be a non-empty array of extensions`)
  }
  const result = value.map((item) => (item.startsWith('.') ? item : `.${item}`).toLowerCase())
  if (new Set(result).size !== result.length) {
    throw new ArchitectureConfigError(`${name} must not contain duplicate extensions`)
  }
  return result
}

function normalizeDirectoryList(value, name) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new ArchitectureConfigError(`${name} must be a non-empty array of directory names`)
  }
  const result = value.map((item) => item.trim())
  if (
    result.some(
      (item) =>
        item === '' || item.includes('/') || item.includes('\\') || item === '.' || item === '..',
    )
  ) {
    throw new ArchitectureConfigError(`${name} must contain directory names only`)
  }
  if (new Set(result).size !== result.length) {
    throw new ArchitectureConfigError(`${name} must not contain duplicate directory names`)
  }
  return result
}

function normalizeRootList(value, name, { oneSegment = false } = {}) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new ArchitectureConfigError(`${name} must be a non-empty array of relative paths`)
  }
  const result = value.map((item) => normalizeRelative(item, `${name} entry`))
  if (oneSegment && result.some((item) => item.includes('/'))) {
    throw new ArchitectureConfigError(`${name} entries must be one path segment`)
  }
  if (new Set(result).size !== result.length) {
    throw new ArchitectureConfigError(`${name} must not contain duplicate paths`)
  }
  return result
}

function loadConfig(root) {
  const configPath = path.join(root, CONFIG_FILE)
  if (!isRegularFile(configPath)) {
    throw new ArchitectureConfigError(`missing ${CONFIG_FILE} at ${relativePath(root, configPath)}`)
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new ArchitectureConfigError(
      `cannot parse ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArchitectureConfigError(`${CONFIG_FILE} must contain a JSON object`)
  }

  const sourceRoot = normalizeRelative(raw.sourceRoot, 'sourceRoot')
  const serverRoot = normalizeRelative(raw.serverRoot, 'serverRoot')
  const allowedRoots = normalizeRootList(raw.allowedRoots, 'allowedRoots', { oneSegment: true })
  const legacyRoots = normalizeRootList(raw.legacyRoots, 'legacyRoots')
  const featureRoot = normalizeRelative(raw.featureRoot, 'featureRoot')
  if (!allowedRoots.includes(featureRoot)) {
    throw new ArchitectureConfigError('featureRoot must be one of allowedRoots')
  }
  const featureManifest = normalizeRelative(raw.featureManifest, 'featureManifest')
  const publicEntry = normalizeRelative(raw.publicEntry, 'publicEntry')
  if (featureManifest.includes('/') || publicEntry.includes('/')) {
    throw new ArchitectureConfigError(
      'featureManifest and publicEntry must be direct feature files',
    )
  }

  if (typeof raw.alias !== 'string' || raw.alias.trim() === '') {
    throw new ArchitectureConfigError('alias must be a non-empty string')
  }
  const alias = raw.alias.endsWith('/') ? raw.alias : `${raw.alias}/`
  if (alias.includes('\\') || alias.includes('..')) {
    throw new ArchitectureConfigError('alias must not contain backslashes or parent segments')
  }

  if (!Number.isInteger(raw.maxProductionFileLines) || raw.maxProductionFileLines <= 0) {
    throw new ArchitectureConfigError('maxProductionFileLines must be a positive integer')
  }
  if (
    !Array.isArray(raw.sizeExcludedPatterns) ||
    raw.sizeExcludedPatterns.some((item) => typeof item !== 'string')
  ) {
    throw new ArchitectureConfigError('sizeExcludedPatterns must be an array of strings')
  }
  let sizeExcludedRegexes
  try {
    sizeExcludedRegexes = raw.sizeExcludedPatterns.map((pattern) => new RegExp(pattern, 'i'))
  } catch (error) {
    throw new ArchitectureConfigError(
      `sizeExcludedPatterns contains an invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return {
    sourceRoot,
    allowedRoots,
    legacyRoots,
    featureRoot,
    featureManifest,
    publicEntry,
    alias,
    sourceExtensions: normalizeExtensionList(raw.sourceExtensions, 'sourceExtensions'),
    sizeExtensions: normalizeExtensionList(raw.sizeExtensions, 'sizeExtensions'),
    serverRoot,
    serverSizeExtensions: normalizeExtensionList(raw.serverSizeExtensions, 'serverSizeExtensions'),
    maxProductionFileLines: raw.maxProductionFileLines,
    sizeExcludedPatterns: [...raw.sizeExcludedPatterns],
    sizeExcludedRegexes,
    excludedDirectories: normalizeDirectoryList(raw.excludedDirectories, 'excludedDirectories'),
  }
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

function collectFiles(root, relativeRoot, config) {
  const scanRoot = path.join(root, relativeRoot)
  const files = []
  const unsupported = []
  const excluded = new Set(config.excludedDirectories)

  function visit(directory) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        compareStrings(left.name, right.name),
      )
    } catch (error) {
      unsupported.push({
        file: directory,
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }

    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) visit(file)
        continue
      }
      if (entry.isFile()) {
        files.push(file)
        continue
      }
      if (entry.isSymbolicLink()) {
        unsupported.push({ file, reason: 'symbolic links are not scanned' })
        continue
      }
      unsupported.push({ file, reason: 'unsupported filesystem entry' })
    }
  }

  if (isDirectory(scanRoot)) visit(scanRoot)
  files.sort((left, right) => compareStrings(relativePath(root, left), relativePath(root, right)))
  unsupported.sort((left, right) =>
    compareStrings(relativePath(root, left.file), relativePath(root, right.file)),
  )
  return { files, unsupported }
}

function collectSourceFiles(root, config) {
  return collectFiles(root, config.sourceRoot, config)
}

function collectServerFiles(root, config) {
  return collectFiles(root, config.serverRoot, config)
}

function makeViolation(root, code, file, line, message) {
  return {
    code,
    file: relativePath(root, file),
    line: Number.isInteger(line) && line > 0 ? line : 1,
    message,
  }
}

function sortViolations(violations) {
  return violations.sort(
    (left, right) =>
      compareStrings(left.file, right.file) ||
      left.line - right.line ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.message, right.message),
  )
}

function sourceRelative(sourceRoot, file) {
  const relative = posixPath(path.relative(sourceRoot, file))
  if (relative === '' || relative === '.' || relative.startsWith('../')) return null
  return relative
}

function isLegacyRelative(sourceRelativePath, legacyRoot) {
  return sourceRelativePath === legacyRoot || sourceRelativePath.startsWith(`${legacyRoot}/`)
}

function layerForSource(sourceRelativePath, config) {
  const parts = sourceRelativePath.split('/')
  if (parts[0] === 'app') return { kind: 'app' }
  if (parts[0] === 'shared') return { kind: 'shared' }
  if (parts[0] === config.featureRoot && parts.length >= 2) {
    return { kind: 'feature', id: parts[1] }
  }
  return null
}

function featureIdIsValid(id) {
  return FEATURE_ID_PATTERN.test(id)
}

function inspectFeatures(root, config, violations) {
  const sourceRoot = path.join(root, config.sourceRoot)
  const featureRoot = path.join(sourceRoot, config.featureRoot)
  const featureIds = new Set()
  const manifestByFeature = new Map()
  const featureDirectories = []
  const excluded = new Set(config.excludedDirectories)

  if (!isDirectory(featureRoot)) return { featureIds, manifestByFeature }

  let entries = readdirSync(featureRoot, { withFileTypes: true })
  entries = entries.sort((left, right) => compareStrings(left.name, right.name))
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue
    const featurePath = path.join(featureRoot, entry.name)
    if (!entry.isDirectory()) {
      violations.push(
        makeViolation(
          root,
          'feature-root-entry',
          featurePath,
          1,
          `feature root may contain directories only; found ${entry.name}`,
        ),
      )
      continue
    }
    featureIds.add(entry.name)
    featureDirectories.push({ id: entry.name, path: featurePath })
  }

  for (const feature of featureDirectories) {
    if (!featureIdIsValid(feature.id)) {
      violations.push(
        makeViolation(
          root,
          'invalid-feature-id',
          feature.path,
          1,
          `feature directory name must match ${FEATURE_ID_PATTERN}; found ${feature.id}`,
        ),
      )
    }

    const manifestPath = path.join(feature.path, config.featureManifest)
    const publicEntryPath = path.join(feature.path, config.publicEntry)
    if (!isRegularFile(manifestPath)) {
      violations.push(
        makeViolation(
          root,
          'missing-feature-manifest',
          manifestPath,
          1,
          `feature "${feature.id}" must define ${config.featureManifest}`,
        ),
      )
    }
    if (!isRegularFile(publicEntryPath)) {
      violations.push(
        makeViolation(
          root,
          'missing-public-entry',
          publicEntryPath,
          1,
          `feature "${feature.id}" must expose ${config.publicEntry}`,
        ),
      )
    }

    let manifest = null
    let manifestParsed = false
    if (isRegularFile(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        manifestParsed = true
      } catch (error) {
        violations.push(
          makeViolation(
            root,
            'invalid-module-manifest',
            manifestPath,
            1,
            `cannot parse ${config.featureManifest}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }

    let dependencies = new Set()
    if (manifestParsed && manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      if (manifest.id !== feature.id) {
        violations.push(
          makeViolation(
            root,
            'module-id-mismatch',
            manifestPath,
            1,
            `module.json id must equal feature directory "${feature.id}"`,
          ),
        )
      }
      if (!Array.isArray(manifest.dependencies)) {
        violations.push(
          makeViolation(
            root,
            'invalid-module-dependencies',
            manifestPath,
            1,
            'module.json dependencies must be an array of feature ids',
          ),
        )
      } else {
        dependencies = new Set()
        for (const dependency of manifest.dependencies) {
          if (typeof dependency !== 'string' || !featureIdIsValid(dependency)) {
            violations.push(
              makeViolation(
                root,
                'invalid-module-dependency',
                manifestPath,
                1,
                `module.json dependency must be a feature id; found ${JSON.stringify(dependency)}`,
              ),
            )
            continue
          }
          if (dependencies.has(dependency)) {
            violations.push(
              makeViolation(
                root,
                'duplicate-module-dependency',
                manifestPath,
                1,
                `module.json lists dependency "${dependency}" more than once`,
              ),
            )
            continue
          }
          dependencies.add(dependency)
          if (dependency === feature.id) {
            violations.push(
              makeViolation(
                root,
                'self-module-dependency',
                manifestPath,
                1,
                `feature "${feature.id}" cannot depend on itself`,
              ),
            )
          }
        }
      }
    } else if (manifestParsed) {
      violations.push(
        makeViolation(
          root,
          'invalid-module-manifest',
          manifestPath,
          1,
          'module.json must contain an object',
        ),
      )
    }
    manifestByFeature.set(feature.id, { dependencies, manifestPath })
  }

  for (const [featureId, manifest] of manifestByFeature) {
    for (const dependency of manifest.dependencies) {
      if (!featureIds.has(dependency)) {
        violations.push(
          makeViolation(
            root,
            'unknown-module-dependency',
            manifest.manifestPath,
            1,
            `feature "${featureId}" declares unknown dependency "${dependency}"`,
          ),
        )
      }
    }
  }

  return { featureIds, manifestByFeature }
}

function checkStructure(root, config, files, unsupported, violations) {
  const sourceRoot = path.join(root, config.sourceRoot)
  if (!isDirectory(sourceRoot)) {
    violations.push(
      makeViolation(
        root,
        'missing-source-root',
        sourceRoot,
        1,
        `source root ${config.sourceRoot} must be a directory`,
      ),
    )
  }

  for (const allowedRoot of config.allowedRoots) {
    const layerPath = path.join(sourceRoot, allowedRoot)
    if (!isDirectory(layerPath)) {
      violations.push(
        makeViolation(
          root,
          'missing-layer-root',
          layerPath,
          1,
          `target layer src/${allowedRoot} must be a directory`,
        ),
      )
    }
  }

  for (const legacyRoot of config.legacyRoots) {
    const legacyPath = path.join(sourceRoot, ...legacyRoot.split('/'))
    if (existsSync(legacyPath)) {
      violations.push(
        makeViolation(
          root,
          'legacy-root',
          legacyPath,
          1,
          `legacy source root src/${legacyRoot} is forbidden`,
        ),
      )
    }
  }

  for (const entry of unsupported) {
    violations.push(makeViolation(root, 'unsupported-source-entry', entry.file, 1, entry.reason))
  }

  for (const file of files) {
    const relative = sourceRelative(sourceRoot, file)
    if (!relative) continue
    if (config.legacyRoots.some((legacyRoot) => isLegacyRelative(relative, legacyRoot))) continue
    const topLevel = relative.split('/')[0]
    if (!config.allowedRoots.includes(topLevel)) {
      violations.push(
        makeViolation(
          root,
          'source-outside-layer',
          file,
          1,
          `source file must live under src/${config.allowedRoots.join(', src/')}; found src/${relative}`,
        ),
      )
    }
  }
}

function checkServerStructure(root, config, unsupported, violations) {
  const serverRoot = path.join(root, config.serverRoot)
  if (!isDirectory(serverRoot)) {
    violations.push(
      makeViolation(
        root,
        'missing-server-root',
        serverRoot,
        1,
        `server root ${config.serverRoot} must be a directory`,
      ),
    )
  }
  for (const entry of unsupported) {
    violations.push(makeViolation(root, 'unsupported-server-entry', entry.file, 1, entry.reason))
  }
}

function tokenize(source) {
  const tokens = []
  let index = 0
  let line = 1

  const addToken = (kind, value, tokenLine, tokenIndex, extra = {}) => {
    tokens.push({ kind, value, line: tokenLine, index: tokenIndex, ...extra })
  }

  while (index < source.length) {
    const character = source[index]
    if (character === '\n') {
      line += 1
      index += 1
      continue
    }
    if (character === '\r') {
      if (source[index + 1] === '\n') index += 1
      line += 1
      index += 1
      continue
    }
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          index += 2
          break
        }
        if (source[index] === '\n') line += 1
        if (source[index] === '\r') {
          if (source[index + 1] === '\n') index += 1
          line += 1
        }
        index += 1
      }
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character
      const tokenLine = line
      const tokenIndex = index
      let value = ''
      let hasInterpolation = false
      index += 1
      while (index < source.length) {
        const current = source[index]
        if (current === '\\') {
          const next = source[index + 1]
          if (next === '\n') line += 1
          if (next === '\r') {
            if (source[index + 2] === '\n') index += 1
            line += 1
          }
          if (next !== undefined) value += next
          index += next === undefined ? 1 : 2
          continue
        }
        if (quote === '`' && current === '$' && source[index + 1] === '{') hasInterpolation = true
        if (current === quote) {
          index += 1
          break
        }
        if (current === '\n') line += 1
        if (current === '\r') {
          if (source[index + 1] === '\n') index += 1
          line += 1
        }
        value += current
        index += 1
      }
      addToken('string', value, tokenLine, tokenIndex, { hasInterpolation })
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      const tokenLine = line
      const tokenIndex = index
      let value = character
      index += 1
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        value += source[index]
        index += 1
      }
      addToken('identifier', value, tokenLine, tokenIndex)
      continue
    }
    addToken('punctuation', character, line, index)
    index += 1
  }
  return tokens
}

function findFromSpecifier(tokens, start) {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.value === ';') return null
    if (
      index > start &&
      token.kind === 'identifier' &&
      (token.value === 'import' || token.value === 'export') &&
      token.line > tokens[start].line
    ) {
      return null
    }
    if (token.kind === 'identifier' && token.value === 'from') {
      const candidate = tokens[index + 1]
      if (candidate?.kind === 'string' && !candidate.hasInterpolation) return candidate
    }
  }
  return null
}

function extractModuleSpecifiers(source) {
  const tokens = tokenize(source)
  const imports = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'identifier') continue

    if (token.value === 'import') {
      const next = tokens[index + 1]
      if (next?.value === '.') continue
      if (next?.value === '(') {
        const candidate = tokens[index + 2]
        if (candidate?.kind === 'string' && !candidate.hasInterpolation) {
          imports.push({ specifier: candidate.value, line: candidate.line })
        }
        continue
      }
      if (next?.kind === 'string' && !next.hasInterpolation) {
        imports.push({ specifier: next.value, line: next.line })
        continue
      }
      const candidate = findFromSpecifier(tokens, index + 1)
      if (candidate) imports.push({ specifier: candidate.value, line: candidate.line })
      continue
    }

    if (token.value === 'export') {
      const candidate = findFromSpecifier(tokens, index + 1)
      if (candidate) imports.push({ specifier: candidate.value, line: candidate.line })
      continue
    }

    if (token.value === 'require' && tokens[index + 1]?.value === '(') {
      const candidate = tokens[index + 2]
      if (candidate?.kind === 'string' && !candidate.hasInterpolation) {
        imports.push({ specifier: candidate.value, line: candidate.line })
      }
    }
  }
  return imports
}

function classifySourceTarget(relative, via, config) {
  const normalized = posixPath(path.posix.normalize(relative))
  if (!normalized || normalized === '.' || normalized.startsWith('../')) {
    return { kind: 'invalid', via, relative: normalized }
  }
  const parts = normalized.split('/')
  if (parts[0] === config.featureRoot) {
    if (!parts[1]) return { kind: 'invalid', via, relative: normalized }
    return {
      kind: 'feature',
      id: parts[1],
      via,
      public: via === 'alias' && parts.length === 2,
      relative: normalized,
    }
  }
  if (parts[0] === 'app') return { kind: 'app', via, relative: normalized }
  if (parts[0] === 'shared') return { kind: 'shared', via, relative: normalized }
  return { kind: 'unknown', via, relative: normalized }
}

function classifyImport(specifier, sourceFile, sourceRoot, config) {
  if (specifier === config.alias.slice(0, -1)) {
    return { kind: 'invalid', via: 'alias', relative: '' }
  }
  if (specifier.startsWith(config.alias)) {
    return classifySourceTarget(specifier.slice(config.alias.length), 'alias', config)
  }
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(sourceFile), specifier)
    const relative = sourceRelative(sourceRoot, target)
    if (!relative) return null
    return classifySourceTarget(relative, 'relative', config)
  }
  return null
}

function checkImportRules(root, config, files, featureContext, violations) {
  const sourceRoot = path.join(root, config.sourceRoot)
  const codeExtensions = new Set(config.sourceExtensions)
  for (const file of files) {
    if (!codeExtensions.has(path.extname(file).toLowerCase())) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      violations.push(
        makeViolation(
          root,
          'unreadable-source',
          file,
          1,
          `cannot read source file: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      continue
    }
    const relative = sourceRelative(sourceRoot, file)
    if (!relative) continue
    const sourceLayer = layerForSource(relative, config)
    if (!sourceLayer) continue
    for (const imported of extractModuleSpecifiers(source)) {
      const target = classifyImport(imported.specifier, file, sourceRoot, config)
      if (!target) continue
      if (target.kind === 'invalid') {
        violations.push(
          makeViolation(
            root,
            'invalid-import-path',
            file,
            imported.line,
            `import path "${imported.specifier}" does not resolve to a target layer`,
          ),
        )
        continue
      }
      if (target.kind === 'unknown') {
        violations.push(
          makeViolation(
            root,
            'import-outside-layer',
            file,
            imported.line,
            `import path "${imported.specifier}" targets outside src/app, src/features, or src/shared`,
          ),
        )
        continue
      }

      if (sourceLayer.kind === 'shared' && (target.kind === 'app' || target.kind === 'feature')) {
        violations.push(
          makeViolation(
            root,
            'forbidden-layer-import',
            file,
            imported.line,
            `shared cannot import ${target.kind === 'app' ? 'app' : `feature "${target.id}"`}`,
          ),
        )
      }
      if (sourceLayer.kind === 'feature' && target.kind === 'app') {
        violations.push(
          makeViolation(
            root,
            'forbidden-layer-import',
            file,
            imported.line,
            `feature "${sourceLayer.id}" cannot import app`,
          ),
        )
      }

      if (
        sourceLayer.kind === 'feature' &&
        target.kind === 'feature' &&
        sourceLayer.id !== target.id
      ) {
        if (target.via !== 'alias' || !target.public) {
          violations.push(
            makeViolation(
              root,
              'cross-feature-import',
              file,
              imported.line,
              `cross-feature imports must use the public alias @/features/${target.id}`,
            ),
          )
        }
        if (!featureContext.featureIds.has(target.id)) {
          violations.push(
            makeViolation(
              root,
              'unknown-feature-import',
              file,
              imported.line,
              `import references unknown feature "${target.id}"`,
            ),
          )
        } else {
          const manifest = featureContext.manifestByFeature.get(sourceLayer.id)
          if (!manifest?.dependencies.has(target.id)) {
            violations.push(
              makeViolation(
                root,
                'undeclared-feature-dependency',
                file,
                imported.line,
                `feature "${sourceLayer.id}" must declare dependency "${target.id}" in module.json`,
              ),
            )
          }
        }
      }

      if (sourceLayer.kind === 'app' && target.kind === 'feature') {
        if (target.via !== 'alias' || !target.public) {
          violations.push(
            makeViolation(
              root,
              'feature-public-api',
              file,
              imported.line,
              `app imports must use the public alias @/features/${target.id}`,
            ),
          )
        }
        if (!featureContext.featureIds.has(target.id)) {
          violations.push(
            makeViolation(
              root,
              'unknown-feature-import',
              file,
              imported.line,
              `import references unknown feature "${target.id}"`,
            ),
          )
        }
      }
    }
  }
}

function countLines(source) {
  if (source.length === 0) return 0
  const lineBreaks = source.split(/\r\n|\n|\r/)
  return lineBreaks.length - (/(?:\r\n|\n|\r)$/.test(source) ? 1 : 0)
}

function isExcludedFromSize(relative, config) {
  return config.sizeExcludedRegexes.some((pattern) => pattern.test(relative))
}

function checkFileSizes(root, config, files, sizeExtensions, violations) {
  const extensions = new Set(sizeExtensions)
  for (const file of files) {
    const relative = relativePath(root, file)
    if (!extensions.has(path.extname(file).toLowerCase())) continue
    if (isExcludedFromSize(relative, config)) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch (error) {
      violations.push(
        makeViolation(
          root,
          'unreadable-source',
          file,
          1,
          `cannot read source file: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      continue
    }
    const lines = countLines(source)
    if (lines > config.maxProductionFileLines) {
      violations.push(
        makeViolation(
          root,
          'production-file-too-large',
          file,
          1,
          `production TypeScript file has ${lines} lines; limit is ${config.maxProductionFileLines}`,
        ),
      )
    }
  }
}

export function checkArchitecture(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot)
  const config = loadConfig(root)
  const sourceScan = collectSourceFiles(root, config)
  const serverScan = collectServerFiles(root, config)
  const violations = []
  checkStructure(root, config, sourceScan.files, sourceScan.unsupported, violations)
  checkServerStructure(root, config, serverScan.unsupported, violations)
  const featureContext = inspectFeatures(root, config, violations)
  checkImportRules(root, config, sourceScan.files, featureContext, violations)
  checkFileSizes(root, config, sourceScan.files, config.sizeExtensions, violations)
  checkFileSizes(root, config, serverScan.files, config.serverSizeExtensions, violations)
  sortViolations(violations)

  return {
    root,
    config,
    files: sourceScan.files.map((file) => relativePath(root, file)),
    serverFiles: serverScan.files.map((file) => relativePath(root, file)),
    unsupported: [...sourceScan.unsupported, ...serverScan.unsupported].map((entry) => ({
      ...entry,
      file: relativePath(root, entry.file),
    })),
    featureIds: [...featureContext.featureIds].sort(compareStrings),
    violations,
    stats: {
      filesScanned: sourceScan.files.length,
      codeFilesScanned: sourceScan.files.filter((file) =>
        config.sourceExtensions.includes(path.extname(file).toLowerCase()),
      ).length,
      serverFilesScanned: serverScan.files.length,
      serverCodeFilesScanned: serverScan.files.filter((file) =>
        config.serverSizeExtensions.includes(path.extname(file).toLowerCase()),
      ).length,
      features: featureContext.featureIds.size,
    },
  }
}

export function formatViolation(violation) {
  return `${violation.file}:${violation.line} [${violation.code}] ${violation.message}`
}

function usage() {
  return [
    'Usage: node scripts/quality/check-architecture.mjs [--root <repository>]',
    '',
    'Scans architecture.json, source files under sourceRoot, and production TypeScript under serverRoot.',
    'Exit codes: 0 = pass, 1 = architecture violations, 2 = configuration/CLI error.',
  ].join('\n')
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

export function main(argumentsList = process.argv.slice(2), output = console) {
  try {
    const argumentsValue = parseArguments(argumentsList)
    if (argumentsValue.help) {
      output.log(usage())
      return 0
    }
    const result = checkArchitecture(argumentsValue.root)
    if (result.violations.length === 0) {
      output.log(
        `architecture gate passed: ${result.stats.filesScanned} source files, ${result.stats.features} features`,
      )
      return 0
    }
    for (const violation of result.violations) output.log(formatViolation(violation))
    output.log(`architecture gate failed: ${result.violations.length} violation(s)`)
    return 1
  } catch (error) {
    output.error(
      `architecture gate error: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 2
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedFile === import.meta.url) process.exitCode = main()
