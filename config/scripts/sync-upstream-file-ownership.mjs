#!/usr/bin/env node
/**
 * Resolves, for an in-progress upstream sync merge, which side of each differing file wins,
 * using `config/fork-ownership.json` as the source of truth instead of commit authorship.
 *
 * The manifest declares four classes: `exception` (whole-file, the fork side always wins;
 * an entry may carry `deleted: true`, meaning the fork's intent for that upstream path is
 * removal), `seam` (a real three-way merge where only the declared lines are protected),
 * `feature` (a fork-owned path matched by a feature glob), and the unmatched default
 * `upstream`. This script turns that classification into four newline-delimited path lists
 * for the sync procedure to act on.
 *
 * Usage:
 *   node config/scripts/sync-upstream-file-ownership.mjs <target-ref> <merge-head> <out-dir>
 *   node config/scripts/sync-upstream-file-ownership.mjs --verify-seams [<ref-or-worktree>]
 *
 * The first form writes checkout.txt, remove.txt, ours.txt and merge-review.txt into
 * <out-dir>. The second confirms every declared seam line is still present verbatim in its
 * file, so a merge or an edit can't silently erode a seam's protected footprint; it reads
 * from a git ref when given one, otherwise from a worktree path (the working tree if the
 * argument is omitted).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadForkOwnershipManifest, classifyPath } from './fork-ownership-manifest.mjs'

const MANIFEST_PATH = 'config/fork-ownership.json'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
const lines = (value) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

// no fallback on failure: resolving a file the wrong way is worse than refusing to sync.
function loadManifestOrExit() {
  let jsonText
  try {
    jsonText = readFileSync(MANIFEST_PATH, 'utf8')
  } catch (error) {
    console.error(`cannot read fork ownership manifest at ${MANIFEST_PATH}: ${error.message}`)
    process.exit(2)
  }
  try {
    return loadForkOwnershipManifest(jsonText)
  } catch (error) {
    console.error(`fork ownership manifest is invalid: ${error.message}`)
    process.exit(2)
  }
}

function classify(manifest, target, mergeHead, outDir) {
  const differing = lines(git('diff', '--name-only', mergeHead, target))
  if (differing.length === 0) {
    console.error('no differing paths between merge-head and target-ref; refusing to classify')
    process.exit(2)
  }
  const targetTree = new Set(lines(git('ls-tree', '-r', '--name-only', target)))

  const checkout = []
  const remove = []
  const ours = []
  const mergeReview = []

  for (const path of differing) {
    const result = classifyPath(manifest, path)
    if (result.class === 'exception') {
      const list = result.entry.deleted ? remove : ours
      list.push(path)
    } else if (result.class === 'seam' || result.class === 'feature') {
      mergeReview.push(path)
    } else {
      const list = targetTree.has(path) ? checkout : remove
      list.push(path)
    }
  }

  writeFileSync(join(outDir, 'checkout.txt'), `${checkout.join('\n')}\n`)
  writeFileSync(join(outDir, 'remove.txt'), `${remove.join('\n')}\n`)
  writeFileSync(join(outDir, 'ours.txt'), `${ours.join('\n')}\n`)
  writeFileSync(join(outDir, 'merge-review.txt'), `${mergeReview.join('\n')}\n`)

  console.log(`differing paths: ${differing.length}`)
  console.log(
    `checkout ${checkout.length}, remove ${remove.length}, ours ${ours.length}, merge-review ${mergeReview.length}`
  )
}

// a bare argument could name either a git ref or a worktree directory; rev-parse is the
// only reliable way to tell them apart, so let it decide rather than guessing from shape.
function resolveSeamSource(refOrWorktree) {
  if (!refOrWorktree) {
    return { kind: 'worktree', root: '.' }
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${refOrWorktree}^{commit}`], {
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return { kind: 'ref', ref: refOrWorktree }
  } catch {
    return { kind: 'worktree', root: refOrWorktree }
  }
}

function readSeamFile(source, path) {
  if (source.kind === 'ref') {
    return git('show', `${source.ref}:${path}`)
  }
  return readFileSync(join(source.root, path), 'utf8')
}

function findMissingSeamLines(manifest, refOrWorktree) {
  const source = resolveSeamSource(refOrWorktree)
  const missing = []
  for (const seam of manifest.seams) {
    let content
    try {
      content = readSeamFile(source, seam.path)
    } catch (error) {
      missing.push(`${seam.path}: cannot read (${error.message})`)
      continue
    }
    for (const line of seam.lines) {
      if (!content.includes(line)) {
        missing.push(`${seam.path}: missing line ${JSON.stringify(line)}`)
      }
    }
  }
  return missing
}

function verifySeams(manifest, refOrWorktree) {
  const missing = findMissingSeamLines(manifest, refOrWorktree)
  if (missing.length > 0) {
    console.error(`--verify-seams: ${missing.length} seam line(s) not found`)
    for (const entry of missing) {
      console.error(`  ${entry}`)
    }
    process.exit(1)
  }
  const totalLines = manifest.seams.reduce((count, seam) => count + seam.lines.length, 0)
  console.log(
    `--verify-seams: all ${totalLines} seam line(s) present across ${manifest.seams.length} file(s)`
  )
  process.exit(0)
}

const argv = process.argv.slice(2)

if (argv[0] === '--verify-seams') {
  verifySeams(loadManifestOrExit(), argv[1])
} else {
  const [TARGET, MERGE_HEAD, OUT] = argv
  if (!TARGET || !MERGE_HEAD || !OUT) {
    console.error('usage: sync-upstream-file-ownership.mjs <target-ref> <merge-head> <out-dir>')
    process.exit(2)
  }
  classify(loadManifestOrExit(), TARGET, MERGE_HEAD, OUT)
}
