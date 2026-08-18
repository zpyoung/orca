/**
 * Parses and matches the fork-ownership manifest that records which files this
 * fork owns outright (seams, exceptions) versus which features claim files by
 * glob pattern. Dependency-free ESM: both the sync classifier and a bare
 * GitHub-runner CI guard import only this module plus node: builtins.
 */

const SEAM_KINDS = new Set(['registration', 'import-swap', 'passthrough'])
const EXCEPTION_STATUSES = new Set(['permanent', 'pending-upstream', 'pending-decision'])

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function validateFeature(feature, index) {
  if (!isNonEmptyString(feature?.name)) {
    throw new Error(`features[${index}] is missing a non-empty "name"`)
  }
  const { name } = feature
  if (!isNonEmptyString(feature.purpose)) {
    throw new Error(`Feature "${name}" is missing a non-empty "purpose"`)
  }
  if (!Array.isArray(feature.globs)) {
    throw new Error(`Feature "${name}" has a "globs" field that is not an array`)
  }
  for (const glob of feature.globs) {
    try {
      compileGlobPattern(glob)
    } catch (error) {
      throw new Error(`Feature "${name}" has an invalid glob pattern: ${error.message}`)
    }
  }
  return feature
}

function validateSeam(seam, index, featureNames) {
  if (!isNonEmptyString(seam?.path)) {
    throw new Error(`seams[${index}] is missing a non-empty "path"`)
  }
  const { path } = seam
  if (!isNonEmptyString(seam.feature)) {
    throw new Error(`Seam "${path}" is missing a non-empty "feature"`)
  }
  if (seam.feature !== 'fork-infra' && !featureNames.has(seam.feature)) {
    throw new Error(`Seam "${path}" references unknown feature "${seam.feature}"`)
  }
  if (!SEAM_KINDS.has(seam.kind)) {
    throw new Error(`Seam "${path}" has an invalid "kind": ${JSON.stringify(seam.kind)}`)
  }
  if (!Array.isArray(seam.lines) || seam.lines.length === 0) {
    throw new Error(`Seam "${path}" must have a non-empty "lines" array`)
  }
  for (const line of seam.lines) {
    if (!isNonEmptyString(line)) {
      throw new Error(`Seam "${path}" has a "lines" entry that is not a non-empty string`)
    }
  }
  return seam
}

function validateException(exception, index) {
  if (!isNonEmptyString(exception?.path)) {
    throw new Error(`exceptions[${index}] is missing a non-empty "path"`)
  }
  const { path } = exception
  if (!isNonEmptyString(exception.reason)) {
    throw new Error(`Exception "${path}" is missing a non-empty "reason"`)
  }
  if (!EXCEPTION_STATUSES.has(exception.status)) {
    throw new Error(
      `Exception "${path}" has an invalid "status": ${JSON.stringify(exception.status)}`
    )
  }
  const hasLedger = exception.ledger !== undefined
  if (exception.status === 'pending-upstream' && !isNonEmptyString(exception.ledger)) {
    throw new Error(
      `Exception "${path}" has status "pending-upstream" and must include a "ledger"`
    )
  }
  if (exception.status !== 'pending-upstream' && hasLedger) {
    throw new Error(`Exception "${path}" has a "ledger" but status is not "pending-upstream"`)
  }
  if (exception.deleted !== undefined && typeof exception.deleted !== 'boolean') {
    throw new Error(`Exception "${path}" has a "deleted" field that is not a boolean`)
  }
  return exception
}

/**
 * Parses and validates fork-ownership manifest JSON against the schema's
 * invariants: unique feature names, seam/feature references that resolve,
 * no path shared between seams and exceptions, well-formed enum values and
 * glob syntax, and the ledger-iff-pending-upstream rule.
 * @throws {Error} naming the offending entry, on any invariant violation or malformed input.
 */
export function loadForkOwnershipManifest(jsonText) {
  let parsed
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`Fork ownership manifest is not valid JSON: ${error.message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Fork ownership manifest must be a JSON object at the top level')
  }
  for (const key of ['features', 'seams', 'exceptions']) {
    if (!Array.isArray(parsed[key])) {
      throw new Error(`Fork ownership manifest is missing required array field "${key}"`)
    }
  }

  const features = parsed.features.map((feature, index) => validateFeature(feature, index))
  const featureNames = new Set()
  for (const feature of features) {
    if (featureNames.has(feature.name)) {
      throw new Error(`Duplicate feature name "${feature.name}"`)
    }
    featureNames.add(feature.name)
  }

  const seams = parsed.seams.map((seam, index) => validateSeam(seam, index, featureNames))
  const exceptions = parsed.exceptions.map((exception, index) =>
    validateException(exception, index)
  )

  const seamPaths = new Set(seams.map((seam) => seam.path))
  for (const exception of exceptions) {
    if (seamPaths.has(exception.path)) {
      throw new Error(`Path "${exception.path}" appears in both "seams" and "exceptions"`)
    }
  }

  return { features, seams, exceptions }
}

const DISALLOWED_GLOB_CHARS = /[?{}[\]!]/
const REGEXP_SPECIAL_CHARS = new Set(['.', '+', '^', '$', '(', ')', '|', '\\'])

function escapeRegExpChar(char) {
  return REGEXP_SPECIAL_CHARS.has(char) ? `\\${char}` : char
}

function compileLiteralSegment(segment) {
  let compiled = ''
  for (const char of segment) {
    compiled += char === '*' ? '[^/]*' : escapeRegExpChar(char)
  }
  return compiled
}

// the grammar is closed and hand-rolled (no minimatch/glob dep in a module the
// CI guard loads with no install step): split on '/' into literal-or-"**"
// segments, then reject any '**' that shares a segment with other characters.
function compileGlobPattern(pattern) {
  if (!isNonEmptyString(pattern)) {
    throw new Error(`Glob pattern must be a non-empty string, got ${JSON.stringify(pattern)}`)
  }
  const disallowed = pattern.match(DISALLOWED_GLOB_CHARS)
  if (disallowed) {
    throw new Error(`Unsupported glob syntax in "${pattern}": "${disallowed[0]}" is not supported`)
  }

  const atoms = []
  for (const segment of pattern.split('/')) {
    if (segment === '**') {
      if (atoms.at(-1)?.type !== 'flex') {
        atoms.push({ type: 'flex' })
      }
      continue
    }
    if (segment.includes('**')) {
      throw new Error(
        `Unsupported glob syntax in "${pattern}": "**" must occupy its own path segment`
      )
    }
    atoms.push({ type: 'literal', source: compileLiteralSegment(segment) })
  }

  let source = '^'
  atoms.forEach((atom, index) => {
    if (atom.type === 'literal') {
      source += atom.source
      if (atoms[index + 1]?.type === 'literal') {
        source += '/'
      }
      return
    }
    const isFirst = index === 0
    const isLast = index === atoms.length - 1
    // a "**" segment is legal on any side of a literal segment (leading,
    // middle, or trailing) and always includes its own adjoining separator,
    // so it matches zero directories with no leftover slash either way.
    source += isFirst && isLast ? '.*' : isFirst ? '(?:.*/)?' : isLast ? '(?:/.*)?' : '/(?:.*/)?'
  })
  return new RegExp(`${source}$`)
}

/**
 * Tests a repo-relative POSIX path against one glob pattern from the
 * manifest's closed grammar: a directory wildcard (a segment consisting of
 * exactly two literal stars), a single-segment `*`, and literal text.
 * @throws {Error} if the pattern uses syntax outside that grammar.
 */
export function matchGlob(pattern, path) {
  return compileGlobPattern(pattern).test(path)
}

/**
 * Classifies a repo-relative path against a loaded manifest, applying strict
 * precedence: an exact exceptions match beats an exact seams match, which
 * beats any feature glob match, which beats the 'upstream' default.
 */
export function classifyPath(manifest, path) {
  const exception = manifest.exceptions.find((entry) => entry.path === path)
  if (exception) {
    return { class: 'exception', entry: exception }
  }
  const seam = manifest.seams.find((entry) => entry.path === path)
  if (seam) {
    return { class: 'seam', entry: seam }
  }
  const feature = manifest.features.find((entry) =>
    entry.globs.some((glob) => matchGlob(glob, path))
  )
  if (feature) {
    return { class: 'feature', entry: feature }
  }
  return { class: 'upstream' }
}
