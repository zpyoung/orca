import { describe, expect, it } from 'vitest'

import {
  findStaleAllowlistEntries,
  findUnreviewedHits,
  importsExhaustiveModule,
  isSweepHit,
  parseAllowlist
} from './check-tab-content-type-audit.mjs'

describe('isSweepHit', () => {
  it('matches a `.contentType` read', () => {
    expect(isSweepHit("if (tab.contentType === 'pipeline') {}")).toBe(true)
  })

  it('matches a closed terminal/editor union declaration', () => {
    expect(isSweepHit("type X = 'terminal' | 'editor' | 'browser'")).toBe(true)
  })

  it('does not match ordinary source', () => {
    expect(isSweepHit('export function f() { return 1 }')).toBe(false)
  })
})

describe('importsExhaustiveModule', () => {
  it('detects a relative import of the exhaustive helper', () => {
    expect(
      importsExhaustiveModule(
        "import { assertExhaustiveTabContentType } from '../../../../shared/tab-content-type-exhaustive'\n"
      )
    ).toBe(true)
  })

  it('returns false when the file has no such import', () => {
    expect(importsExhaustiveModule("import { foo } from './bar'\n")).toBe(false)
  })
})

describe('parseAllowlist', () => {
  it('drops comments and blank lines', () => {
    expect(parseAllowlist('# header\n\nsrc/a.ts\nsrc/b.tsx\n')).toEqual(
      new Set(['src/a.ts', 'src/b.tsx'])
    )
  })
})

describe('findUnreviewedHits', () => {
  it('flags a hit that neither imports the helper nor is allowlisted', () => {
    const hits = [
      { path: 'src/a.ts', importsExhaustive: true },
      { path: 'src/b.ts', importsExhaustive: false },
      { path: 'src/c.ts', importsExhaustive: false }
    ]
    const allowlist = new Set(['src/c.ts'])
    expect(findUnreviewedHits(hits, allowlist)).toEqual([
      { path: 'src/b.ts', importsExhaustive: false }
    ])
  })

  it('is clean when every hit is covered', () => {
    const hits = [{ path: 'src/a.ts', importsExhaustive: true }]
    expect(findUnreviewedHits(hits, new Set())).toEqual([])
  })
})

describe('findStaleAllowlistEntries', () => {
  it('reports allowlist entries no longer hit by the sweep', () => {
    const hits = [{ path: 'src/a.ts', importsExhaustive: false }]
    const allowlist = new Set(['src/a.ts', 'src/gone.ts'])
    expect(findStaleAllowlistEntries(hits, allowlist)).toEqual(['src/gone.ts'])
  })
})
