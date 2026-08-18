import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const scriptPath = join(projectDir, 'config/scripts/sync-upstream-file-ownership.mjs')
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-sync-ownership-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'sync-ownership-test@example.com'])
  git(root, ['config', 'user.name', 'Sync Ownership Test'])
  return root
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

function commitAll(root, message) {
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function writeManifest(root, manifest) {
  writeFiles(root, { 'config/fork-ownership.json': JSON.stringify(manifest, null, 2) })
}

function baseManifest(overrides = {}) {
  return { features: [], seams: [], exceptions: [], ...overrides }
}

function runScript(root, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: 'utf8' })
}

function outLines(outDir, name) {
  return readFileSync(join(outDir, name), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('classify mode', () => {
  it('sorts each differing path into the list its class requires', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    // manifest content stays identical across both commits so it never itself
    // shows up in the differing-paths diff the classifier is being tested against
    writeManifest(
      root,
      baseManifest({
        features: [{ name: 'fork-x', purpose: 'x', globs: ['tests/feature-owned/**'] }],
        seams: [
          {
            path: 'src/seam-owned.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ],
        exceptions: [{ path: 'docs/ours.md', reason: 'fork policy doc', status: 'permanent' }]
      })
    )
    writeFiles(root, {
      'src/upstream-changed.ts': 'merge-head version\n',
      'src/upstream-removed.ts': 'merge-head version\n'
    })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, {
      'docs/ours.md': 'upstream content\n',
      'src/seam-owned.ts': 'const SEAM_MARKER = true\nupstream addition\n',
      'tests/feature-owned/case.spec.ts': 'upstream version\n',
      'src/upstream-changed.ts': 'target version\n'
    })
    // upstream dropped this file in the target tag
    rmSync(join(root, 'src/upstream-removed.ts'))
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'checkout.txt')).toEqual(['src/upstream-changed.ts'])
    expect(outLines(outDir, 'remove.txt')).toEqual(['src/upstream-removed.ts'])
    expect(outLines(outDir, 'ours.txt')).toEqual(['docs/ours.md'])
    expect(outLines(outDir, 'merge-review.txt').sort()).toEqual(
      ['src/seam-owned.ts', 'tests/feature-owned/case.spec.ts'].sort()
    )
  })

  it('routes a deleted exception to remove.txt even when the path exists at the target', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        exceptions: [
          {
            path: 'src/fork-only.ts',
            reason: 'fork removed this upstream file',
            status: 'permanent',
            deleted: true
          }
        ]
      })
    )
    writeFiles(root, { 'src/fork-only.ts': 'fork content\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'src/fork-only.ts': 'upstream still ships this\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'remove.txt')).toEqual(['src/fork-only.ts'])
    expect(outLines(outDir, 'ours.txt')).toEqual([])
    expect(outLines(outDir, 'checkout.txt')).toEqual([])
  })

  it('prefers an exception over a matching feature glob at the same path', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        features: [{ name: 'fork-x', purpose: 'x', globs: ['src/overlap.ts'] }],
        exceptions: [
          { path: 'src/overlap.ts', reason: 'fork owns this outright', status: 'permanent' }
        ]
      })
    )
    writeFiles(root, { 'src/overlap.ts': 'merge-head version\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'src/overlap.ts': 'target version\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'ours.txt')).toEqual(['src/overlap.ts'])
    expect(outLines(outDir, 'merge-review.txt')).toEqual([])
  })

  it('does not write coupled-tests.txt', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(root, baseManifest())
    writeFiles(root, { 'src/a.ts': 'merge-head\n' })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(existsSync(join(outDir, 'coupled-tests.txt'))).toBe(false)
  })

  it('exits 2 with a usage message when invoked with no arguments', () => {
    const root = initRepo()
    writeFiles(root, { 'README.md': 'base\n' })
    commitAll(root, 'base')

    const result = runScript(root, [])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage')
  })

  it('exits 2 when the manifest is missing', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeFiles(root, { 'src/a.ts': 'merge-head\n' })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('exits 2 when the manifest is invalid', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeFiles(root, {
      'config/fork-ownership.json': '{"features": [], "seams": []}',
      'src/a.ts': 'merge-head\n'
    })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('exits 2 when there are no differing paths to classify', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeManifest(root, baseManifest())
    writeFiles(root, { 'src/a.ts': 'same\n' })
    const mergeHead = commitAll(root, 'only-commit')

    const result = runScript(root, [mergeHead, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

describe('--verify-seams mode', () => {
  it('exits 0 against the working tree when every declared seam line is present', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(0)
  })

  it('exits 1 and names the missing line when a seam line is absent from the working tree', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')
    // corrupt the working tree copy without committing, to prove the default
    // (no ref argument) mode reads the working tree and not a git ref
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/seam.ts')
  })

  it('reads from a git ref rather than a dirty working tree when a ref is given', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    const head = commitAll(root, 'base')
    // dirty the working tree after the commit; a ref-based check must ignore this
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams', head])

    expect(result.status).toBe(0)
  })

  it('reads from a worktree path argument that is not a valid git ref', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')

    const worktreePath = join(root, '..', `${dirname(root).split('/').pop()}-wt`)
    git(root, ['worktree', 'add', '--quiet', worktreePath, 'HEAD'])
    tempDirs.push(worktreePath)

    // dirty the primary working tree; the worktree-path argument must read its own disk copy
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams', worktreePath])

    expect(result.status).toBe(0)
  })

  it('exits 2 when the manifest is missing', () => {
    const root = initRepo()
    writeFiles(root, { 'README.md': 'base\n' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(2)
  })

  it('exits 2 when the manifest is invalid', () => {
    const root = initRepo()
    writeFiles(root, { 'config/fork-ownership.json': 'not json' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(2)
  })
})
