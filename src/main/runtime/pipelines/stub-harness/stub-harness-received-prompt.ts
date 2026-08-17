/** Reads what a stub invocation actually received, as captured from inside the runner process. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The exact prompt argv the runner observed — never what the test believes it sent. */
export function readStubReceivedPrompt(controlDir: string, index: number): string {
  return readFileSync(join(controlDir, `${index}.received-prompt.txt`), 'utf8')
}

/** The runner's full argv (minus the node/script tokens), for asserting invocation shape. */
export function readStubReceivedArgv(controlDir: string, index: number): string[] {
  const raw = readFileSync(join(controlDir, `${index}.received-argv.json`), 'utf8')
  return JSON.parse(raw) as string[]
}
