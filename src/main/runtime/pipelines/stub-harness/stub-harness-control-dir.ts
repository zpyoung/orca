/** The filesystem rendezvous point between a test and the stub agent processes it spawns. */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let counter = 0

/** A fresh directory under `baseDir` for one test's control files (scripts, prompts, outcomes). */
export function createStubHarnessControlDir(baseDir: string): string {
  counter += 1
  const dir = join(baseDir, `stub-control-${process.pid}-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export class StubHarnessTimeoutError extends Error {}

/** Polls until `path` exists or `timeoutMs` elapses, so a stuck runner fails loudly, not silently. */
export async function waitForStubFile(
  path: string,
  timeoutMs: number,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(path)) {
      return
    }
    if (Date.now() >= deadline) {
      throw new StubHarnessTimeoutError(`Timed out after ${timeoutMs}ms waiting for ${path}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
