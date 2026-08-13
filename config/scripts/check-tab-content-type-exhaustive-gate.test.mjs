import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { insertDummyMember, main } from './check-tab-content-type-exhaustive-gate.mjs'

const FIXTURE_UNION = `export type TabContentType =
  | 'terminal'
  | 'editor'
  | 'pipeline'

export type WorkspaceVisibleTabType = 'terminal' | 'editor'
`

describe('insertDummyMember', () => {
  it('appends the dummy member after the last union line, matching its indentation', () => {
    const mutated = insertDummyMember(FIXTURE_UNION)
    expect(mutated).toBe(`export type TabContentType =
  | 'terminal'
  | 'editor'
  | 'pipeline'
  | '__gate1_dummy_member__'

export type WorkspaceVisibleTabType = 'terminal' | 'editor'
`)
  })

  it('preserves tab indentation if the source uses tabs', () => {
    const tabbed = "export type TabContentType =\n\t| 'terminal'\n\t| 'editor'\n"
    expect(insertDummyMember(tabbed)).toBe(
      "export type TabContentType =\n\t| 'terminal'\n\t| 'editor'\n\t| '__gate1_dummy_member__'\n"
    )
  })

  it('returns null when the declaration is absent', () => {
    expect(insertDummyMember("export type Something = 'a' | 'b'\n")).toBeNull()
  })

  it('returns null when the union uses an inline single-line form', () => {
    expect(insertDummyMember("export type TabContentType = 'terminal' | 'editor'\n")).toBeNull()
  })
})

describe('main', () => {
  const tempDirs = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  // main() reads root/src/shared/types.ts (the real project's relative path),
  // so every fixture root mirrors that layout.
  function makeFixtureRoot(contents = FIXTURE_UNION) {
    const root = mkdtempSync(join(tmpdir(), 'orca-tab-content-type-gate-'))
    tempDirs.push(root)
    const dir = join(root, 'src', 'shared')
    mkdirSync(dir, { recursive: true })
    const typesFile = join(dir, 'types.ts')
    writeFileSync(typesFile, contents)
    return { root, typesFile }
  }

  it('passes and restores the file when the injected typecheck fails', () => {
    const { root, typesFile } = makeFixtureRoot()
    const seenDuringRun = []
    const runTypecheck = vi.fn((r) => {
      seenDuringRun.push(readFileSync(join(r, 'src/shared/types.ts'), 'utf8'))
      return false
    })

    const exitCode = main({ root, runTypecheck })

    expect(exitCode).toBe(0)
    expect(seenDuringRun[0]).toContain('__gate1_dummy_member__')
    expect(readFileSync(typesFile, 'utf8')).toBe(FIXTURE_UNION)
  })

  it('fails and still restores the file when the injected typecheck succeeds', () => {
    const { root, typesFile } = makeFixtureRoot()

    const exitCode = main({ root, runTypecheck: () => true })

    expect(exitCode).toBe(1)
    expect(readFileSync(typesFile, 'utf8')).toBe(FIXTURE_UNION)
  })

  it('restores the file when the injected typecheck throws', () => {
    const { root, typesFile } = makeFixtureRoot()

    expect(() =>
      main({
        root,
        runTypecheck: () => {
          throw new Error('boom')
        }
      })
    ).toThrow('boom')
    expect(readFileSync(typesFile, 'utf8')).toBe(FIXTURE_UNION)
  })

  it('leaves the file untouched and fails when the union anchor is not found', () => {
    const noAnchor = "export type Something = 'a' | 'b'\n"
    const { root, typesFile } = makeFixtureRoot(noAnchor)
    const runTypecheck = vi.fn()

    const exitCode = main({ root, runTypecheck })

    expect(exitCode).toBe(1)
    expect(runTypecheck).not.toHaveBeenCalled()
    expect(readFileSync(typesFile, 'utf8')).toBe(noAnchor)
  })
})
