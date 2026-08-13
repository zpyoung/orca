import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Consumer-audit gate for the pipeline-canvas tab-content-type forcing function
// (src/shared/tab-content-type-exhaustive.ts).
//
// The forcing function only proves that CONVERTED switches are exhaustive — it
// says nothing about a file that reads `tab.contentType` and was never converted
// at all. This gate closes that gap mechanically: every file that references
// `.contentType` or a closed terminal/editor union must either import the
// exhaustive helper (so a future member fails its typecheck) or be named, with
// a reason, in the reviewed allowlist. A new consumer file that does neither
// fails this check until it is converted or explicitly allowlisted in review.
//
// This is file-granular, not line-granular: a file with one converted switch and
// one unconverted else-chain still passes. See the allowlist's own header for
// the residual this gate does not close.

const ALLOWLIST_PATH = 'config/tab-content-type-audit-allowlist.txt'
const EXHAUSTIVE_MODULE_PATH = 'src/shared/tab-content-type-exhaustive.ts'
const SCAN_DIRS = ['src/renderer/src', 'src/shared']
const CONTENT_TYPE_RE = /\.contentType\b/
const CLOSED_UNION_RE = /'terminal'\s*\|\s*'editor'/

function isScannable(relPath) {
  if (!SCAN_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`))) {
    return false
  }
  if (!/\.(ts|tsx)$/.test(relPath)) {
    return false
  }
  if (/\.(test|spec)\.(ts|tsx)$/.test(relPath) || relPath.endsWith('.d.ts')) {
    return false
  }
  return true
}

export function isSweepHit(sourceText) {
  return CONTENT_TYPE_RE.test(sourceText) || CLOSED_UNION_RE.test(sourceText)
}

export function importsExhaustiveModule(sourceText) {
  return /from\s+['"][^'"]*tab-content-type-exhaustive['"]/.test(sourceText)
}

export function parseAllowlist(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

/** Every tracked file the sweep hits, mapped to whether it self-clears the gate. */
export function collectSweepHits(root = process.cwd()) {
  const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)
    .filter(isScannable)
    .filter((rel) => rel !== EXHAUSTIVE_MODULE_PATH)

  const hits = []
  for (const rel of tracked) {
    let src
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    if (!isSweepHit(src)) {
      continue
    }
    hits.push({ path: rel, importsExhaustive: importsExhaustiveModule(src) })
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path))
}

export function findUnreviewedHits(hits, allowlist) {
  return hits.filter((hit) => !hit.importsExhaustive && !allowlist.has(hit.path))
}

export function findStaleAllowlistEntries(hits, allowlist) {
  const hitPaths = new Set(hits.map((h) => h.path))
  return [...allowlist].filter((entry) => !hitPaths.has(entry)).sort()
}

function printUnreviewedFailure(unreviewed) {
  for (const hit of unreviewed) {
    console.error(`::error::New tab-content-type consumer not reviewed: ${hit.path}`)
  }
  console.error('')
  console.error('╭──────────────────────────────────────────────────────────────────────────╮')
  console.error('│  tab-content-type audit failed — a new/changed consumer is not reviewed   │')
  console.error('╰──────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  ${unreviewed.length} file(s) reference .contentType or a closed terminal/editor`)
  console.error('  union without importing tab-content-type-exhaustive.ts:')
  console.error('')
  for (const hit of unreviewed) {
    console.error(`    • ${hit.path}`)
  }
  console.error('')
  console.error('  ✅  Fix it: convert the boundary to an exhaustive `switch (tab.contentType)`')
  console.error('      that imports assertExhaustiveTabContentType, OR — if every read here is a')
  console.error(`      closed positive check with correct fallthrough — add the file to`)
  console.error(`      ${ALLOWLIST_PATH} with a one-line reason.`)
  console.error('')
}

export function main(root = process.cwd()) {
  const allowlistFile = path.join(root, ALLOWLIST_PATH)
  if (!fs.existsSync(allowlistFile)) {
    console.error(`::error::Missing ${ALLOWLIST_PATH}.`)
    return 1
  }
  const allowlist = parseAllowlist(fs.readFileSync(allowlistFile, 'utf8'))
  const hits = collectSweepHits(root)
  const unreviewed = findUnreviewedHits(hits, allowlist)
  const stale = findStaleAllowlistEntries(hits, allowlist)

  if (unreviewed.length > 0) {
    printUnreviewedFailure(unreviewed)
    return 1
  }
  if (stale.length > 0) {
    for (const entry of stale) {
      console.error(`::error::Stale tab-content-type allowlist entry (no longer hit): ${entry}`)
    }
    console.error(`  Remove stale entries from ${ALLOWLIST_PATH} — they no longer reference`)
    console.error('  `.contentType` or a closed terminal/editor union.')
    return 1
  }

  console.log(
    `tab-content-type audit OK — ${hits.length} consumer(s) reviewed (${allowlist.size} allowlisted).`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd()))
}
