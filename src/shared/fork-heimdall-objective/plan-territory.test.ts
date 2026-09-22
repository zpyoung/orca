import { describe, expect, it } from 'vitest'
import {
  objectiveGlobWithin,
  objectiveGlobsOverlap,
  objectiveTerritoriesOverlap,
  objectiveTerritoryWithin
} from './plan-territory'

describe('objectiveGlobWithin', () => {
  it('accepts a literal within an identical literal', () => {
    expect(objectiveGlobWithin('src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('accepts a concrete file within a recursive directory glob', () => {
    expect(objectiveGlobWithin('src/a/*.ts', 'src/**')).toBe(true)
  })

  it('rejects a recursive glob within a single-segment wildcard', () => {
    expect(objectiveGlobWithin('src/**', 'src/*')).toBe(false)
  })

  it('accepts a suffix-narrowed wildcard within a bare wildcard segment', () => {
    expect(objectiveGlobWithin('src/*.ts', 'src/*')).toBe(true)
  })

  it('accepts a recursive glob within itself', () => {
    expect(objectiveGlobWithin('**', '**')).toBe(true)
  })

  it('rejects a recursive glob within a rooted recursive glob', () => {
    expect(objectiveGlobWithin('**', 'src/**')).toBe(false)
  })

  it('accepts a single-character wildcard within a bare wildcard segment', () => {
    expect(objectiveGlobWithin('src/a?.ts', 'src/*')).toBe(true)
  })
})

describe('objectiveTerritoryWithin', () => {
  it('requires every inner glob to fit under some outer glob', () => {
    expect(objectiveTerritoryWithin(['src/a.ts', 'src/b/*.ts'], ['src/**'])).toBe(true)
    expect(objectiveTerritoryWithin(['src/a.ts', 'docs/**'], ['src/**'])).toBe(false)
  })
})

describe('objectiveGlobsOverlap', () => {
  it('rejects disjoint literals', () => {
    expect(objectiveGlobsOverlap('src/a.ts', 'src/b.ts')).toBe(false)
  })

  it('rejects suffix-incompatible wildcard segments', () => {
    expect(objectiveGlobsOverlap('src/*.ts', 'src/*.tsx')).toBe(false)
  })

  it('accepts prefix/suffix-compatible wildcard segments', () => {
    expect(objectiveGlobsOverlap('src/a*', 'src/*b')).toBe(true)
  })

  it('accepts a recursive glob against a concrete descendant path', () => {
    expect(objectiveGlobsOverlap('src/**', 'src/x/y.ts')).toBe(true)
  })

  it('rejects disjoint rooted recursive globs', () => {
    expect(objectiveGlobsOverlap('docs/**', 'src/**')).toBe(false)
  })

  it('accepts an unrooted recursive glob against a matching concrete path', () => {
    expect(objectiveGlobsOverlap('**/*.test.ts', 'src/a/b.test.ts')).toBe(true)
  })
})

describe('objectiveTerritoriesOverlap', () => {
  it('requires at least one overlapping pair', () => {
    expect(objectiveTerritoriesOverlap(['docs/**'], ['src/**', 'docs/*.md'])).toBe(true)
    expect(objectiveTerritoriesOverlap(['docs/**'], ['src/**'])).toBe(false)
  })
})
