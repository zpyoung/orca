import { describe, expect, it } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import { inspectHostedReviewSitterPolicy } from './agent-policy'

function modified(path: string): GitStatusResult {
  return {
    conflictOperation: 'unknown',
    entries: [{ path, status: 'modified', area: 'unstaged' }]
  }
}

describe('inspectHostedReviewSitterPolicy', () => {
  it.each([
    'config/max-lines-baseline.txt',
    'config/runtime-electron-baseline.txt',
    'config/scripts/check-max-lines-ratchet.mjs'
  ])('rejects unattended baseline or ratchet edits at %s', (path) => {
    expect(inspectHostedReviewSitterPolicy(modified(path), '')).toEqual({
      reason: 'quality-baseline-change-forbidden',
      path
    })
  })

  it('catches a suppression on an added line whose content starts with ++', () => {
    const patch = [
      'diff --git a/src/counter.ts b/src/counter.ts',
      '--- a/src/counter.ts',
      '+++ b/src/counter.ts',
      '@@ -1,0 +1,1 @@',
      '+++i // eslint-disable-line no-plusplus'
    ].join('\n')
    expect(inspectHostedReviewSitterPolicy(modified('src/counter.ts'), patch)).toEqual({
      reason: 'new-lint-or-type-suppression-forbidden'
    })
  })

  it('still ignores the real file headers of a clean patch', () => {
    const patch = [
      'diff --git a/src/counter.ts b/src/counter.ts',
      '--- a/src/counter.ts',
      '+++ b/src/counter.ts',
      '@@ -1,0 +1,1 @@',
      '+const next = count + 1'
    ].join('\n')
    expect(inspectHostedReviewSitterPolicy(modified('src/counter.ts'), patch)).toBeNull()
  })

  it.each([
    'config/scripts/check-release-gates.mjs',
    'tools/verify-quality.ts',
    'config/unit/vitest.config.ts',
    'packages/desktop/playwright.config.ts'
  ])('rejects unattended gate-definition edits at %s', (path) => {
    expect(inspectHostedReviewSitterPolicy(modified(path), '')).toEqual({
      reason: 'ci-definition-change-requires-human-review',
      path
    })
  })
})
