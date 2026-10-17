import { describe, expect, it } from 'vitest'
import { isNoProgress, protectedPathHits } from './loop-progress'
import type { CheckOutcome, IterationRecord } from './loop-types'

function check(overrides: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    ran: true,
    pass: false,
    exitCode: 1,
    timedOut: false,
    stdoutTail: 'out',
    stderrTail: 'err',
    durationMs: 10,
    ...overrides
  }
}

function record(n: number, overrides: Partial<IterationRecord> = {}): IterationRecord {
  return {
    n,
    attempt: 0,
    startedAt: n * 1000,
    endedAt: n * 1000 + 500,
    endReason: 'settled',
    check: check(),
    evaluator: null,
    diff: null,
    treeBefore: 'tree-a',
    treeAfter: 'tree-a',
    costUsd: null,
    markers: [],
    protectedPathHits: [],
    checkpointCommit: null,
    ...overrides
  }
}

describe('isNoProgress', () => {
  it('is false with fewer than three settled iterations', () => {
    expect(isNoProgress([record(1)], record(2))).toBe(false)
  })

  it('is true after exactly three unchanged iterations with the same check outcome', () => {
    const history = [record(1), record(2), record(3)]
    expect(isNoProgress(history, record(3))).toBe(true)
    expect(isNoProgress(history.slice(0, 2), record(3))).toBe(true)
  })

  it('is false when any of the last three changed the tree', () => {
    const history = [record(1), record(2, { treeAfter: 'tree-b' }), record(3)]
    expect(isNoProgress(history, record(3))).toBe(false)
  })

  it('only looks at the last three settled iterations', () => {
    const history = [record(1, { treeAfter: 'tree-b' }), record(2), record(3), record(4)]
    expect(isNoProgress(history, record(4))).toBe(true)
  })

  it('is false when the check outcome differs across the window', () => {
    const history = [
      record(1),
      record(2, { check: check({ pass: true, exitCode: 0 }) }),
      record(3)
    ]
    expect(isNoProgress(history, record(3))).toBe(false)
  })

  it('ignores crashed attempts when counting settled iterations', () => {
    const history = [record(1), record(2, { endReason: 'crashed' }), record(3)]
    expect(isNoProgress(history, record(3))).toBe(false)
  })

  it('counts a latest record that is not yet in history', () => {
    expect(isNoProgress([record(1), record(2)], record(3))).toBe(true)
  })

  it('falls back to identical check output when folder workspaces have no trees', () => {
    const noTree = { treeBefore: null, treeAfter: null }
    const same = [record(1, noTree), record(2, noTree), record(3, noTree)]
    expect(isNoProgress(same, record(3, noTree))).toBe(true)

    const changing = [
      record(1, noTree),
      record(2, { ...noTree, check: check({ stdoutTail: 'different' }) }),
      record(3, noTree)
    ]
    expect(isNoProgress(changing, record(3, noTree))).toBe(false)
  })

  it('has no signal without trees or a check', () => {
    const bare = { treeBefore: null, treeAfter: null, check: null }
    const history = [record(1, bare), record(2, bare), record(3, bare)]
    expect(isNoProgress(history, record(3, bare))).toBe(false)
  })
})

describe('protectedPathHits', () => {
  it('matches recursive and single-segment globs', () => {
    const files = ['.github/workflows/ci.yml', 'src/a.ts', 'src/deep/b.ts', 'README.md']
    expect(protectedPathHits(files, ['.github/**'])).toEqual(['.github/workflows/ci.yml'])
    expect(protectedPathHits(files, ['src/*.ts'])).toEqual(['src/a.ts'])
    expect(protectedPathHits(files, ['src/**/*.ts'])).toEqual(['src/a.ts', 'src/deep/b.ts'])
  })

  it('matches an exact repo-relative path', () => {
    expect(protectedPathHits(['package.json', 'sub/package.json'], ['package.json'])).toEqual([
      'package.json'
    ])
  })

  it('normalizes windows separators and a leading ./', () => {
    expect(protectedPathHits(['.\\config\\app.json', './x.txt'], ['config/*.json', 'x.txt'])).toEqual(
      ['.\\config\\app.json', './x.txt']
    )
  })

  it('treats a trailing slash as a directory prefix', () => {
    expect(protectedPathHits(['secrets/a/b.key', 'secretsX/b.key'], ['secrets/'])).toEqual([
      'secrets/a/b.key'
    ])
  })

  it('supports braces, ? and character classes', () => {
    const files = ['a.ts', 'a.js', 'a.md', 'b1.txt', 'bx.txt']
    expect(protectedPathHits(files, ['*.{ts,js}'])).toEqual(['a.ts', 'a.js'])
    expect(protectedPathHits(files, ['b?.txt'])).toEqual(['b1.txt', 'bx.txt'])
    expect(protectedPathHits(files, ['b[0-9].txt'])).toEqual(['b1.txt'])
  })

  it('does not let * cross a directory boundary or treat regex characters specially', () => {
    expect(protectedPathHits(['a/b/c.ts', 'a+b.ts', 'aab.ts'], ['a*c.ts', 'a+b.ts'])).toEqual([
      'a+b.ts'
    ])
  })

  it('returns nothing for empty globs', () => {
    expect(protectedPathHits(['a.ts'], [])).toEqual([])
  })
})
