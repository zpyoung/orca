/** Reads the outcome a stub agent invocation recorded, per its script's `outcome` field. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitForStubFile } from './stub-harness-control-dir'

export type StubInvocationOutcome = {
  index: number
  outcome: 'success' | 'failure'
  message: string | null
}

function outcomePath(controlDir: string, index: number): string {
  return join(controlDir, `${index}.outcome.json`)
}

/** Non-blocking: `undefined` while the invocation hasn't reported yet (still running or held). */
export function readStubOutcomeIfPresent(
  controlDir: string,
  index: number
): StubInvocationOutcome | undefined {
  const path = outcomePath(controlDir, index)
  if (!existsSync(path)) {
    return undefined
  }
  return JSON.parse(readFileSync(path, 'utf8')) as StubInvocationOutcome
}

export async function waitForStubOutcome(
  controlDir: string,
  index: number,
  timeoutMs: number
): Promise<StubInvocationOutcome> {
  const path = outcomePath(controlDir, index)
  await waitForStubFile(path, timeoutMs)
  return JSON.parse(readFileSync(path, 'utf8')) as StubInvocationOutcome
}
