import { describe, expect, it, vi } from 'vitest'
import {
  classifyCustomReviewTarget,
  isWindowsReviewPath,
  resolveReviewTarget,
  type ReviewTargetResolverDependencies
} from './review-target-resolver'

const absentPath = async (): Promise<boolean> => false

function dependencies(
  overrides: Partial<ReviewTargetResolverDependencies> = {}
): ReviewTargetResolverDependencies {
  return {
    pathExists: absentPath,
    resolveGitTarget: async ({ kind, target }) => ({
      targetRef: `${kind}:${target}`,
      baselineOid: 'base',
      headOid: 'head'
    }),
    ...overrides
  }
}

describe('classifyCustomReviewTarget', () => {
  it('gives the exact WORKTREE literal first precedence', async () => {
    const pathExists = vi.fn(async () => true)

    await expect(classifyCustomReviewTarget('WORKTREE', pathExists)).resolves.toBe('worktree')
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('does not normalize near matches of the WORKTREE literal', async () => {
    const pathExists = vi.fn(absentPath)

    await expect(classifyCustomReviewTarget(' WORKTREE ', pathExists)).resolves.toBe('git-range')
    await expect(classifyCustomReviewTarget('worktree', pathExists)).resolves.toBe('git-range')
  })

  it('recognizes drive-letter and UNC paths without consulting the local OS', async () => {
    const pathExists = vi.fn(absentPath)
    const targets = [
      String.raw`C:\repo\file.ts`,
      'd:/repo/file.ts',
      String.raw`E:relative\file.ts`,
      String.raw`\\server\share\file.ts`,
      '//server/share/file.ts'
    ]

    for (const target of targets) {
      expect(isWindowsReviewPath(target)).toBe(true)
      await expect(classifyCustomReviewTarget(target, pathExists)).resolves.toBe('path')
    }
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('prefers an existing execution-host path even when it resembles a range', async () => {
    const pathExists = vi.fn(async (path: string) => path === 'docs/from..to.md')

    await expect(classifyCustomReviewTarget('docs/from..to.md', pathExists)).resolves.toBe('path')
    expect(pathExists).toHaveBeenCalledWith('docs/from..to.md')
  })

  it('falls through to a git range only after the provider reports no path', async () => {
    const pathExists = vi.fn(absentPath)

    await expect(classifyCustomReviewTarget('origin/main..HEAD', pathExists)).resolves.toBe(
      'git-range'
    )
    expect(pathExists).toHaveBeenCalledWith('origin/main..HEAD')
  })
})

describe('resolveReviewTarget', () => {
  it('resolves worktree and explicit path targets without git or filesystem I/O', async () => {
    const pathExists = vi.fn(absentPath)
    const resolveGitTarget = vi.fn()
    const deps = dependencies({ pathExists, resolveGitTarget })

    await expect(resolveReviewTarget({ kind: 'worktree' }, deps)).resolves.toEqual({
      targetKind: 'worktree',
      targetRef: 'WORKTREE'
    })
    await expect(
      resolveReviewTarget({ kind: 'path', target: 'docs/spec.md' }, deps)
    ).resolves.toEqual({ targetKind: 'path', targetRef: 'docs/spec.md' })
    expect(pathExists).not.toHaveBeenCalled()
    expect(resolveGitTarget).not.toHaveBeenCalled()
  })

  it.each(['commit', 'hosted', 'git-range'] as const)(
    'preserves the %s classification while delegating git resolution',
    async (kind) => {
      const resolveGitTarget = vi.fn(async () => ({
        targetRef: 'base-oid..head-oid',
        baselineOid: 'base-oid',
        headOid: 'head-oid',
        providerRef: kind === 'hosted' ? 'MR !42' : null
      }))

      await expect(
        resolveReviewTarget({ kind, target: 'input-ref' }, dependencies({ resolveGitTarget }))
      ).resolves.toEqual({
        targetKind: kind,
        targetRef: 'base-oid..head-oid',
        baselineOid: 'base-oid',
        headOid: 'head-oid',
        providerRef: kind === 'hosted' ? 'MR !42' : null
      })
      expect(resolveGitTarget).toHaveBeenCalledWith({ kind, target: 'input-ref' })
    }
  )

  it('applies custom precedence and delegates the untouched range text', async () => {
    const resolveGitTarget = vi.fn(async ({ target }) => ({ targetRef: target }))
    const deps = dependencies({ resolveGitTarget })

    await expect(
      resolveReviewTarget({ kind: 'custom', target: '--not-an-option..HEAD' }, deps)
    ).resolves.toEqual({ targetKind: 'git-range', targetRef: '--not-an-option..HEAD' })
    expect(resolveGitTarget).toHaveBeenCalledWith({
      kind: 'git-range',
      target: '--not-an-option..HEAD'
    })
  })

  it('returns an existing custom path without invoking the git resolver', async () => {
    const resolveGitTarget = vi.fn()
    const deps = dependencies({ pathExists: async () => true, resolveGitTarget })

    await expect(
      resolveReviewTarget({ kind: 'custom', target: 'docs/plan.md' }, deps)
    ).resolves.toEqual({ targetKind: 'path', targetRef: 'docs/plan.md' })
    expect(resolveGitTarget).not.toHaveBeenCalled()
  })
})
