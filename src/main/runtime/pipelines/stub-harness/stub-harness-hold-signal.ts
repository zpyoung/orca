/** The release-gate side of a stub invocation's `holdAt` boundary. */

import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { waitForStubFile } from './stub-harness-control-dir'

function holdingPath(controlDir: string, index: number, boundary: string): string {
  return join(controlDir, `${index}.holding-${boundary}`)
}

function releasePath(controlDir: string, index: number, boundary: string): string {
  return join(controlDir, `${index}.release-${boundary}`)
}

/** Resolves once the runner has reached the boundary and is blocked there — not before. */
export async function waitForStubHold(
  controlDir: string,
  index: number,
  boundary: string,
  timeoutMs: number
): Promise<void> {
  await waitForStubFile(holdingPath(controlDir, index, boundary), timeoutMs)
}

export function isStubHolding(controlDir: string, index: number, boundary: string): boolean {
  return existsSync(holdingPath(controlDir, index, boundary))
}

/** Lets a held runner proceed past `boundary`. */
export function releaseStubHold(controlDir: string, index: number, boundary: string): void {
  closeSync(openSync(releasePath(controlDir, index, boundary), 'w'))
}
