import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  forkRcNumberFromReleaseSubject,
  forkRcNumberFromTag,
  highestRcForBase
} from './release-rc-history.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function withGitRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-rc-history-'))
  try {
    git(dir, ['init', '--initial-branch=main'])
    git(dir, ['config', 'user.name', 'Test Bot'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function commit(cwd, message, { allowEmpty = true } = {}) {
  const args = ['commit', '-m', message]
  if (allowEmpty) {
    args.splice(1, 0, '--allow-empty')
  }
  git(cwd, args)
}

describe('release RC history', () => {
  it('counts fork RC tags and ignores bare upstream ones', () => {
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7.zy01')).toBe(7)
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7')).toBeNull()
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7.perf')).toBeNull()
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7.zy01-extra')).toBeNull()
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.35-rc.7.zy01')).toBeNull()
  })

  // Why: the counter is zero-padded so it stays string-sortable past zy09. An
  // unpadded tag is not one this fork cuts, and accepting it here would let a
  // zy1/zy01 pair collapse to the same rc number.
  it('rejects an unpadded zy counter', () => {
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7.zy1')).toBeNull()
    expect(forkRcNumberFromTag('1.4.36', 'v1.4.36-rc.7.zy10')).toBe(7)
    expect(forkRcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6.zy1')).toBeNull()
  })

  it('counts fork release subjects with optional slot markers', () => {
    expect(forkRcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6.zy01')).toBe(6)
    expect(
      forkRcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6.zy01 [rc-slot:2026-05-30-03]')
    ).toBe(6)
    expect(forkRcNumberFromReleaseSubject('1.4.36', 'release: v1.4.36-rc.6')).toBeNull()
    expect(forkRcNumberFromReleaseSubject('1.4.36', 'fix: v1.4.36-rc.6.zy01')).toBeNull()
  })

  // Why this case: upstream's release history arrives through every sync. Counting
  // it would pin the gate to upstream's rc number and refuse every fork cut
  // anchored at that same merge-base.
  it('ignores upstream release history inherited through a sync', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.5')
      git(repo, ['tag', 'v1.4.36-rc.5'])
      commit(repo, 'release: v1.4.36-rc.6 [rc-slot:2026-05-30-03]')

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBeNull()
    })
  })

  it('keeps a fork RC counted once its tag is deleted', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.5.zy01')
      git(repo, ['tag', 'v1.4.36-rc.5.zy01'])
      commit(repo, 'release: v1.4.36-rc.6.zy01')

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })

  it('takes the highest fork RC when upstream history interleaves', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.9')
      commit(repo, 'release: v1.4.36-rc.6.zy01')
      git(repo, ['tag', 'v1.4.36-rc.6.zy01'])

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })

  it('considers origin/main when releasing from an older ref', () => {
    withGitRepo((repo) => {
      commit(repo, 'initial')
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      commit(repo, 'release: v1.4.36-rc.6.zy01')
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
      git(repo, ['checkout', 'HEAD~1'])

      expect(highestRcForBase('1.4.36', { cwd: repo })).toBe(6)
    })
  })
})
