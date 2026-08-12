#!/usr/bin/env node
/**
 * Resolves, for an in-progress upstream sync merge, which differing files the fork owns and
 * which must be reset to the upstream release.
 *
 * The fork's main carries upstream commits that only ever existed on an upstream release
 * branch — cherry-picks and reverts that never landed on upstream/main. Upstream's main then
 * evolves that same code, so a blanket `-X ours` preserves the stale release-branch variant
 * while taking upstream's new code around it, and the tree stops cohering. Fork priority is
 * only meaningful for files the fork actually changed.
 *
 * Usage:
 *   node config/scripts/sync-upstream-file-ownership.mjs <target-ref> <merge-head> <out-dir>
 *
 * Writes `checkout.txt` (reset to target), `remove.txt` (absent at target) and
 * `coupled-tests.txt` (kept on the fork side) into <out-dir>.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [TARGET, MERGE_HEAD, OUT] = process.argv.slice(2)
if (!TARGET || !MERGE_HEAD || !OUT) {
  console.error('usage: sync-upstream-file-ownership.mjs <target-ref> <merge-head> <out-dir>')
  process.exit(2)
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const lines = (value) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

// package.json's version line is fork-owned but written by github-actions[bot], so commit
// authorship alone hands the file to upstream and regresses the published version series.
const FORK_OWNED_ALWAYS = new Set(['package.json'])

// The fork's snapshot history cannot be reconciled with upstream's newer skill content: the
// append-only guard rejects it and regeneration cannot repair it. Upstream's artifacts win.
const UPSTREAM_OWNED_ALWAYS = new Set([
  'resources/skills/current-manifest.json',
  'resources/skills/release-mapping.json',
  'resources/skills/snapshot-registry.json'
])

// The fork appends to these, but importing a type or constant from one says nothing about
// whether a test asserts on fork-modified behavior.
const SHARED_BARRELS = new Set(['src/shared/types.ts', 'src/shared/constants.ts'])

const EXTENSIONS = ['', '.ts', '.tsx', '.cjs', '.mjs', '.js', '.jsx', '.json']
const IMPORT_REF = /(?:from\s*|require\(\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g
const isTest = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)

const forkAuthored = lines(
  git(
    'log',
    '--format=%H',
    '--no-merges',
    '--author=zpyoung',
    '--author=Zachary Young',
    'origin/main',
    '--not',
    'upstream/main',
    TARGET
  )
)
if (forkAuthored.length === 0) {
  throw new Error('no fork-authored commits resolved; refusing to classify')
}

const forkOwned = new Set(lines(git('show', '--format=', '--name-only', ...forkAuthored)))
for (const file of FORK_OWNED_ALWAYS) {
  forkOwned.add(file)
}
for (const file of UPSTREAM_OWNED_ALWAYS) {
  forkOwned.delete(file)
}

const differing = lines(git('diff', '--name-only', MERGE_HEAD, TARGET))
const targetTree = new Set(lines(git('ls-tree', '-r', '--name-only', TARGET)))

function resolveImport(fromDir, reference) {
  const stack = []
  for (const segment of `${fromDir}/${reference}`.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  const base = stack.join('/')
  return EXTENSIONS.map((extension) => `${base}${extension}`).find(
    (candidate) => forkOwned.has(candidate) && !SHARED_BARRELS.has(candidate)
  )
}

// A test whose subject the fork owns has to stay on the fork's version: upstream's newer test
// asserts against upstream's implementation, which this tree deliberately does not carry.
const coupledTests = []
for (const file of differing) {
  if (forkOwned.has(file) || !isTest(file) || !targetTree.has(file)) {
    continue
  }
  const directory = file.split('/').slice(0, -1).join('/')
  const content = git('show', `${TARGET}:${file}`)
  const subject = [...content.matchAll(IMPORT_REF)]
    .map((match) => resolveImport(directory, match[1]))
    .find(Boolean)
  if (subject) {
    coupledTests.push({ file, subject })
  }
}
for (const { file } of coupledTests) {
  forkOwned.add(file)
}

const upstreamOwned = differing.filter((file) => !forkOwned.has(file))
const checkout = upstreamOwned.filter((file) => targetTree.has(file))
const remove = upstreamOwned.filter((file) => !targetTree.has(file))

writeFileSync(`${OUT}/checkout.txt`, `${checkout.join('\n')}\n`)
writeFileSync(`${OUT}/remove.txt`, `${remove.join('\n')}\n`)
writeFileSync(
  `${OUT}/coupled-tests.txt`,
  `${coupledTests.map((t) => `${t.file}\t${t.subject}`).join('\n')}\n`
)

console.log(`fork-authored commits: ${forkAuthored.length}`)
console.log(
  `upstream-owned: ${upstreamOwned.length} (reset ${checkout.length}, remove ${remove.length})`
)
console.log(`coupled tests kept on the fork side: ${coupledTests.length}`)
for (const { file, subject } of coupledTests) {
  console.log(`  ${file} -> ${subject}`)
}
