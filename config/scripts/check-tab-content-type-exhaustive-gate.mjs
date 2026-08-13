import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Forcing-function gate for the pipeline-canvas tab-content-type conversion:
// appends a throwaway member to TabContentType, runs the full typecheck, and
// requires it to FAIL. A typecheck that still PASSES means some switch that
// is supposed to be exhaustive over TabContentType silently absorbed the
// unrecognized member instead of erroring on it.
//
// This proves every switch genuinely exhaustive over TabContentType stays
// exhaustive. It proves nothing about a boundary that reads `.contentType`
// without ever being converted to such a switch (see
// check-tab-content-type-audit.mjs for that side), and nothing about a
// switch typed over a separately declared mirror union (e.g. TabCycleType)
// rather than TabContentType itself — mutating TabContentType alone does not
// reach those.
//
// Mutates src/shared/types.ts on disk for the duration of one typecheck run.
// The original bytes are captured before the edit and written back on every
// exit path (normal return, thrown error, SIGINT/SIGTERM) rather than undone
// by a second edit, so restoration can never drift from what was actually
// there. A full-tree copy-and-typecheck-elsewhere scheme was considered
// instead, but the typecheck spans project references across src/main,
// src/renderer, src/shared, and src/relay, so an isolated copy would mean
// duplicating the whole tree rather than one file.

const TYPES_PATH = 'src/shared/types.ts'
const DUMMY_MEMBER = '__gate1_dummy_member__'
const UNION_BLOCK_RE = /export type TabContentType =\n((?:[ \t]*\|[ \t]*'[^']+'\n)+)/

/** Inserts the dummy member after the last line of the TabContentType union; null if the declaration shape isn't found. */
export function insertDummyMember(source) {
  const match = UNION_BLOCK_RE.exec(source)
  if (!match) {
    return null
  }
  const block = match[1]
  const indentMatch = /^([ \t]*)\|/.exec(block)
  const indent = indentMatch ? indentMatch[1] : '  '
  const insertAt = match.index + match[0].length
  return `${source.slice(0, insertAt)}${indent}| '${DUMMY_MEMBER}'\n${source.slice(insertAt)}`
}

function defaultRunTypecheck(root) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, ['run', 'typecheck'], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    throw result.error
  }
  return result.status === 0
}

function printAnchorNotFound() {
  console.error(`::error::Could not locate the TabContentType union in ${TYPES_PATH}.`)
  console.error('  The gate needs to recognize its declaration shape to append a dummy member —')
  console.error('  update the anchor regex in this script if the type moved or its formatting changed.')
}

function printTypecheckDidNotFail() {
  console.error('')
  console.error('╭──────────────────────────────────────────────────────────────────────────╮')
  console.error('│  tab-content-type exhaustiveness gate failed                              │')
  console.error('╰──────────────────────────────────────────────────────────────────────────╯')
  console.error('')
  console.error(`  Appending a throwaway member to TabContentType (${DUMMY_MEMBER}) should break`)
  console.error('  the typecheck at every switch that is exhaustive over TabContentType — it')
  console.error('  did not. Some converted boundary is silently absorbing an unrecognized member')
  console.error("  (a stray `default:` catch-all, or the exhaustiveness call was removed).")
  console.error('')
}

export function main({ root = process.cwd(), runTypecheck = defaultRunTypecheck } = {}) {
  const typesFile = path.join(root, TYPES_PATH)
  const original = fs.readFileSync(typesFile)
  const mutated = insertDummyMember(original.toString('utf8'))
  if (mutated === null) {
    printAnchorNotFound()
    return 1
  }

  let restored = false
  const restore = () => {
    if (restored) {
      return
    }
    restored = true
    fs.writeFileSync(typesFile, original)
  }
  const exitOnSignal = (exitCode) => () => {
    restore()
    process.exit(exitCode)
  }
  process.on('exit', restore)
  process.on('SIGINT', exitOnSignal(130))
  process.on('SIGTERM', exitOnSignal(143))

  try {
    fs.writeFileSync(typesFile, mutated)
    const typecheckPassed = runTypecheck(root)
    if (typecheckPassed) {
      printTypecheckDidNotFail()
      return 1
    }
    console.log('tab-content-type exhaustiveness gate OK — the dummy member broke the typecheck.')
    return 0
  } finally {
    restore()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
