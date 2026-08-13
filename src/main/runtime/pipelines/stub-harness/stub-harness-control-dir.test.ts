import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createStubHarnessControlDir,
  StubHarnessTimeoutError,
  waitForStubFile
} from './stub-harness-control-dir'

describe('createStubHarnessControlDir', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-stub-control-dir-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a fresh, existing directory on every call', () => {
    const first = createStubHarnessControlDir(root)
    const second = createStubHarnessControlDir(root)

    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
    expect(first).not.toBe(second)
  })
})

describe('waitForStubFile', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-stub-wait-file-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // If this resolved (instead of rejecting) for a file that never appears, every
  // hold/outcome wait built on top of it would silently pass regardless of whether the
  // stub actually did anything.
  it('rejects once the timeout elapses for a file that never appears', async () => {
    const target = join(root, 'never-created.txt')

    await expect(waitForStubFile(target, 50, 5)).rejects.toThrow(StubHarnessTimeoutError)
  })

  it('resolves as soon as the file appears, without waiting for the full timeout', async () => {
    const target = join(root, 'appears-soon.txt')
    setTimeout(() => writeFileSync(target, ''), 30)

    const start = Date.now()
    await waitForStubFile(target, 5000, 5)

    expect(Date.now() - start).toBeLessThan(2000)
  })
})
