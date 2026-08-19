#!/usr/bin/env node
/**
 * Enforces config/fork-ownership.json on a pull request: every fork-added file must be
 * declared, every declared entry must still be real, features must not silently swallow a
 * path upstream also tracks, and every declared seam line must still be present verbatim.
 *
 * Invoked as: node .github/scripts/check-fork-ownership.mjs <base-sha> <head-sha>
 * Exit codes: 0 pass, 1 findings, 2 usage or infrastructure error.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  classifyPath,
  loadForkOwnershipManifest,
  matchGlob
} from '../../config/scripts/fork-ownership-manifest.mjs'

const MANIFEST_PATH = 'config/fork-ownership.json'
const UPSTREAM_REPO_URL = 'https://github.com/stablyai/orca.git'
// test-only network bypass: points ls-remote at a local fixture repo instead of upstream; unset in every real workflow run
const UPSTREAM_REMOTE_OVERRIDE_ENV = 'CHECK_FORK_OWNERSHIP_UPSTREAM_REMOTE'

// stderr is captured, not inherited: several calls below embed a manifest-derived path in
// git's argv, and git echoes an unrecognized path back into its error text verbatim — inherited,
// that text would reach the job log outside the stop-commands fence below and could forge a
// workflow command
function gitRaw(args, encoding) {
  // the full-tree listing already runs to hundreds of KB, so the default 1 MiB cap is within
  // reach of ordinary repo growth; match the classifier's ceiling
  return execFileSync('git', args, {
    encoding,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

// see check-root-directory-entries.mjs: latin1 preserves a pathname's raw bytes 1:1,
// where 'utf8' would fold any invalid sequence to U+FFFD and collapse two distinct paths
function gitPathList(args) {
  return gitRaw(args, 'latin1').split('\0').filter(Boolean)
}

function gitText(args) {
  return gitRaw(args, 'utf8')
}

function gitTreePathSet(ref) {
  return new Set(gitPathList(['ls-tree', '-r', '--name-only', '-z', ref]))
}

function toLatin1(value) {
  return Buffer.from(value, 'utf8').toString('latin1')
}

// git-sourced paths above are read as latin1 to preserve raw bytes 1:1 (see gitPathList);
// re-encode the manifest's JSON-parsed UTF-8 strings the same way so a non-ASCII path compares
// equal instead of silently never matching
function toLatin1Manifest(manifest) {
  return {
    features: manifest.features.map((feature) => ({
      ...feature,
      globs: feature.globs.map(toLatin1)
    })),
    seams: manifest.seams.map((seam) => ({ ...seam, path: toLatin1(seam.path) })),
    exceptions: manifest.exceptions.map((exception) => ({
      ...exception,
      path: toLatin1(exception.path)
    }))
  }
}

// upstream keeps tagging past the fork's last sync, so its newest stable tags name commits this
// clone has never fetched; probing one would exit 128 and abort the guard, and a commit we do
// not have cannot be an ancestor of HEAD anyway
function hasCommit(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

function isAncestor(candidateSha, headSha) {
  if (!hasCommit(candidateSha)) {
    return false
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', candidateSha, headSha], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return true
  } catch (error) {
    if (error.status === 1) {
      return false
    }
    throw error
  }
}

function readUpstreamTagRows() {
  const remote = process.env[UPSTREAM_REMOTE_OVERRIDE_ENV] ?? UPSTREAM_REPO_URL
  return gitRaw(['ls-remote', '--tags', remote, 'refs/tags/v[0-9]*'], 'latin1')
}

export function parseTagRows(text) {
  const tags = new Map()
  for (const line of text.split('\n')) {
    const [sha, ref] = line.split('\t')
    if (!sha || !ref || !ref.startsWith('refs/tags/')) {
      continue
    }
    const peeled = ref.endsWith('^{}')
    const name = ref.slice('refs/tags/'.length, peeled ? -'^{}'.length : undefined)
    // an annotated tag's bare row names the tag object, not the commit; the peeled
    // ^{} row is the actual commit and must win whichever order the rows arrive in
    if (peeled || !tags.has(name)) {
      tags.set(name, sha)
    }
  }
  return tags
}

export function isForkTagName(name) {
  return name.includes('-rc') || name.includes('.zy')
}

const VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/

export function parseVersion(name) {
  const match = VERSION_PATTERN.exec(name)
  return match ? match.slice(1).map(Number) : null
}

// compares major/minor/patch as numbers: a lexical sort would rank 'v1.4.180' below 'v1.4.9'
export function compareVersionsDescending(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return b[i] - a[i]
    }
  }
  return 0
}

export function pickComparisonTag(tagRowsText, headSha, checkAncestor = isAncestor) {
  const candidates = [...parseTagRows(tagRowsText)]
    .filter(([name]) => !isForkTagName(name))
    .map(([name, sha]) => ({ name, sha, version: parseVersion(name) }))
    .filter((tag) => tag.version !== null)
    .sort((a, b) => compareVersionsDescending(a.version, b.version))

  for (const candidate of candidates) {
    if (checkAncestor(candidate.sha, headSha)) {
      return candidate
    }
  }
  return null
}

function checkCoverage(findings, manifest, baseSha, headSha, comparisonTreePaths) {
  const added = gitPathList([
    'diff',
    '--name-only',
    '--diff-filter=A',
    // a rename+modify into an undeclared path reports as 'R' with detection on, which
    // --diff-filter=A does not match, so an undeclared new path would escape coverage
    '--no-renames',
    '-z',
    baseSha,
    headSha
  ])
  for (const path of added) {
    if (comparisonTreePaths.has(path)) {
      continue
    }
    if (classifyPath(manifest, path).class === 'upstream') {
      findings.push({
        rule: 'coverage',
        path,
        detail: 'new file is not declared in config/fork-ownership.json'
      })
    }
  }
}

function checkStaleEntries(findings, manifest, headTreePaths) {
  const treeSet = new Set(headTreePaths)
  for (const feature of manifest.features) {
    for (const glob of feature.globs) {
      if (!headTreePaths.some((path) => matchGlob(toLatin1(glob), path))) {
        findings.push({
          rule: 'stale-entry',
          path: null,
          detail: `feature "${feature.name}" glob "${glob}" matches no path at HEAD`
        })
      }
    }
  }
  for (const seam of manifest.seams) {
    if (!treeSet.has(toLatin1(seam.path))) {
      findings.push({
        rule: 'stale-entry',
        path: seam.path,
        detail: 'declared seam is absent from HEAD'
      })
    }
  }
  for (const exception of manifest.exceptions) {
    const present = treeSet.has(toLatin1(exception.path))
    if (exception.deleted && present) {
      findings.push({
        rule: 'stale-entry',
        path: exception.path,
        detail: 'declared deleted but present at HEAD'
      })
    } else if (!exception.deleted && !present) {
      findings.push({
        rule: 'stale-entry',
        path: exception.path,
        detail: 'declared exception is absent from HEAD'
      })
    }
  }
}

function checkSilentCapture(findings, manifest, headTreePaths, comparisonTreePaths) {
  for (const path of headTreePaths) {
    const result = classifyPath(manifest, path)
    if (result.class !== 'feature') {
      continue
    }
    if (comparisonTreePaths.has(path)) {
      findings.push({
        rule: 'silent-capture',
        path,
        detail: `matched by feature "${result.entry.name}" and also tracked upstream, with no seam or exception`
      })
    }
  }
}

function checkSeamIntegrity(findings, manifest, headSha) {
  for (const seam of manifest.seams) {
    let content
    try {
      content = gitText(['show', `${headSha}:${seam.path}`])
    } catch {
      findings.push({ rule: 'seam-integrity', path: seam.path, detail: 'cannot read file at HEAD' })
      continue
    }
    // a whole-line Set, not a substring search: a substring match would let a declared
    // line survive only inside a comment or a longer line and still report as present
    const presentLines = new Set(content.split(/\r\n|\n/))
    for (const line of seam.lines) {
      if (!presentLines.has(line)) {
        findings.push({
          rule: 'seam-integrity',
          path: seam.path,
          detail: `missing seam line ${JSON.stringify(line)}`
        })
      }
    }
  }
}

function findingLineBuffer(finding) {
  const prefix = Buffer.from(`  [${finding.rule}] `, 'utf8')
  const pathBuffer = finding.path !== null ? Buffer.from(finding.path, 'latin1') : Buffer.alloc(0)
  const detailBuffer = Buffer.from(
    finding.path !== null ? `: ${finding.detail}\n` : `${finding.detail}\n`,
    'utf8'
  )
  return Buffer.concat([prefix, pathBuffer, detailBuffer])
}

function reportFindings(findings) {
  if (findings.length === 0) {
    console.log('Fork ownership guard passed: no coverage, staleness, capture, or seam findings.')
    return 0
  }

  console.log(
    '::error title=Fork ownership guard failed::config/fork-ownership.json is out of sync with this pull request.'
  )
  console.log('Fork ownership guard failed.')
  console.log(`Findings (${findings.length}):`)
  // see check-root-directory-entries.mjs: a finding embeds attacker-controlled pathnames and
  // manifest text, so fence the list with an unguessable token to block forged '::' annotations
  const resumeToken = randomUUID()
  console.log(`::stop-commands::${resumeToken}`)
  for (const finding of findings) {
    process.stdout.write(findingLineBuffer(finding))
  }
  console.log(`::${resumeToken}::`)
  return 1
}

function reportInfrastructureFailure(error) {
  const resumeToken = randomUUID()
  console.log(`::stop-commands::${resumeToken}`)
  process.stdout.write(Buffer.from(`git command failed (status ${error.status})\n`, 'utf8'))
  if (typeof error.stderr === 'string' && error.stderr.length > 0) {
    process.stdout.write(Buffer.from(error.stderr, 'latin1'))
  }
  console.log(`::${resumeToken}::`)
}

function checkForkOwnership(argv) {
  if (argv.length !== 2) {
    console.error(`Usage: ${process.argv[1]} <base-sha> <head-sha>`)
    return 2
  }
  const [baseSha, headSha] = argv

  let tagRowsText
  try {
    tagRowsText = readUpstreamTagRows()
  } catch (error) {
    console.error(`failed to list upstream tags: ${error.message}`)
    return 2
  }
  // a dropped connection can exit 0 with a truncated (possibly empty) result, so the
  // exit code alone cannot be trusted to mean "the full tag list arrived"
  if (!tagRowsText.trim()) {
    console.error('upstream tag listing was empty; refusing to guess the comparison ref')
    return 2
  }

  let comparisonTag
  try {
    comparisonTag = pickComparisonTag(tagRowsText, headSha)
  } catch (error) {
    console.error(`failed to resolve the comparison ref: ${error.message}`)
    return 2
  }
  if (!comparisonTag) {
    console.error('no upstream stable tag is reachable from HEAD')
    return 2
  }
  const comparisonRef = comparisonTag.sha
  // names the winning tag so a skipped newer one is visible; safe unfenced because only
  // /^v\d+\.\d+\.\d+$/ names survive candidate selection
  console.log(`Comparing against upstream ${comparisonTag.name}.`)

  let manifestJsonText
  try {
    manifestJsonText = gitText(['show', `${headSha}:${MANIFEST_PATH}`])
  } catch (error) {
    console.error(`failed to read ${MANIFEST_PATH} at HEAD: ${error.message}`)
    return 2
  }

  const findings = []
  let manifest
  try {
    manifest = loadForkOwnershipManifest(manifestJsonText)
  } catch (error) {
    findings.push({
      rule: 'stale-entry',
      path: MANIFEST_PATH,
      detail: `manifest is invalid: ${error.message}`
    })
  }

  if (manifest) {
    const latin1Manifest = toLatin1Manifest(manifest)
    const headTreePaths = gitPathList(['ls-tree', '-r', '--name-only', '-z', headSha])
    const comparisonTreePaths = gitTreePathSet(comparisonRef)
    checkCoverage(findings, latin1Manifest, baseSha, headSha, comparisonTreePaths)
    checkStaleEntries(findings, manifest, headTreePaths)
    checkSilentCapture(findings, latin1Manifest, headTreePaths, comparisonTreePaths)
    checkSeamIntegrity(findings, manifest, headSha)
  }

  return reportFindings(findings)
}

// guards the CLI entry point so the test suite can import the pure functions above
// (parseTagRows, pickComparisonTag, ...) without triggering a real git-touching run
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    // see check-root-directory-entries.mjs: process.exit truncates a piped write
    // part-way through on macOS, so set exitCode and let node flush on its own
    process.exitCode = checkForkOwnership(process.argv.slice(2))
  } catch (error) {
    if (typeof error.status !== 'number') {
      throw error
    }
    // git's stderr is captured rather than inherited (see gitRaw), so nothing about this
    // failure has reached the log yet; the documented contract is 0/1/2, not git's raw status
    reportInfrastructureFailure(error)
    process.exitCode = 2
  }
}
