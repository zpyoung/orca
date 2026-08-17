/** The per-invocation behavior a test hands the stub agent runner before it dispatches. */

import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type StubFileWrite = {
  /** Relative to the runner's working directory (the run worktree). */
  path: string
  content: string
  /** `git add` this path after writing, so the commit (if any) includes it. */
  stage?: boolean
}

export type StubInvocationScript = {
  files?: StubFileWrite[]
  /** Commit message; when set, runs `git commit` after staged files are added. */
  commit?: string
  /** Boundary name to hold at, after files/commit and before the outcome is finalized. */
  holdAt?: string
  outcome: 'success' | 'failure'
  failureMessage?: string
}

function scriptPath(controlDir: string, index: number): string {
  return join(controlDir, `${index}.script.json`)
}

// Why: the runner claims its index and reads this file with no coordination beyond the
// filesystem, so a torn read (write in progress) must never be observable — write to a
// sibling temp path and rename, which is atomic on the same filesystem.
export function writeStubInvocationScript(
  controlDir: string,
  index: number,
  script: StubInvocationScript
): void {
  const target = scriptPath(controlDir, index)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(script))
  renameSync(tmp, target)
}
