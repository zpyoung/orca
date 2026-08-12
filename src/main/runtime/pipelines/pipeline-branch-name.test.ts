import { describe, expect, it } from 'vitest'
import { pipelineBranchName, pipelineBranchSlug } from './pipeline-branch-name'

describe('pipelineBranchSlug', () => {
  it('lowercases and replaces characters outside [a-z0-9-] with -', () => {
    expect(pipelineBranchSlug('Bugfix Fast!')).toBe('bugfix-fast')
    expect(pipelineBranchSlug('a_b.c/d\\e')).toBe('a-b-c-d-e')
  })

  it('collapses consecutive replaced characters into a single -', () => {
    expect(pipelineBranchSlug('a   b')).toBe('a-b')
    expect(pipelineBranchSlug('a!!!b')).toBe('a-b')
    expect(pipelineBranchSlug('a---b')).toBe('a-b')
  })

  it('trims leading and trailing -', () => {
    expect(pipelineBranchSlug('  bugfix  ')).toBe('bugfix')
    expect(pipelineBranchSlug('---weird---')).toBe('weird')
  })

  it('preserves existing valid characters as-is', () => {
    expect(pipelineBranchSlug('bugfix-fast-2')).toBe('bugfix-fast-2')
  })

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(50)
    const slug = pipelineBranchSlug(long)
    expect(slug).toBe('a'.repeat(40))
    expect(slug.length).toBe(40)
  })

  it('re-trims a trailing - introduced by truncation at exactly 40 chars', () => {
    const name = `${'a'.repeat(39)}-b`
    expect(name.length).toBe(41)
    const slug = pipelineBranchSlug(name)
    expect(slug).toBe('a'.repeat(39))
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('falls back to run when the result would be empty', () => {
    expect(pipelineBranchSlug('')).toBe('run')
    expect(pipelineBranchSlug('!!!')).toBe('run')
    expect(pipelineBranchSlug('---')).toBe('run')
    expect(pipelineBranchSlug('   ')).toBe('run')
  })

  it('never produces a slug ending in - or containing --', () => {
    const cases = ['A B_C--D!!!', '###', `${'x'.repeat(45)}---`, '-x-y-z-']
    for (const input of cases) {
      const slug = pipelineBranchSlug(input)
      expect(slug.startsWith('-')).toBe(false)
      expect(slug.endsWith('-')).toBe(false)
      expect(slug).not.toMatch(/--/)
      expect(slug.length).toBeGreaterThan(0)
      expect(slug.length).toBeLessThanOrEqual(40)
    }
  })
})

describe('pipelineBranchName', () => {
  it('returns the base name when it does not already exist', async () => {
    const name = await pipelineBranchName('bugfix-fast', 1, async () => false)
    expect(name).toBe('pipeline/bugfix-fast-1')
  })

  it('appends -2 when the base name already exists', async () => {
    const taken = new Set(['pipeline/bugfix-fast-1'])
    const name = await pipelineBranchName('bugfix-fast', 1, async (n) => taken.has(n))
    expect(name).toBe('pipeline/bugfix-fast-1-2')
  })

  it('walks the first free numeric suffix through several consecutive collisions', async () => {
    const taken = new Set([
      'pipeline/bugfix-fast-1',
      'pipeline/bugfix-fast-1-2',
      'pipeline/bugfix-fast-1-3',
      'pipeline/bugfix-fast-1-4'
    ])
    const name = await pipelineBranchName('bugfix-fast', 1, async (n) => taken.has(n))
    expect(name).toBe('pipeline/bugfix-fast-1-5')
  })

  it('queries existence in increasing suffix order and stops at the first free name', async () => {
    const taken = new Set(['pipeline/bugfix-fast-1', 'pipeline/bugfix-fast-1-2'])
    const queried: string[] = []
    const name = await pipelineBranchName('bugfix-fast', 1, async (n) => {
      queried.push(n)
      return taken.has(n)
    })
    expect(name).toBe('pipeline/bugfix-fast-1-3')
    expect(queried).toEqual(['pipeline/bugfix-fast-1', 'pipeline/bugfix-fast-1-2', 'pipeline/bugfix-fast-1-3'])
  })
})
