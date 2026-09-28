import { describe, expect, it } from 'vitest'
import { gitExecMutatesRepository } from './git-exec-mutation'

describe('gitExecMutatesRepository', () => {
  it.each([
    [['remote', 'add', 'pr-contributor-orca', 'https://github.com/contributor/orca.git']],
    [['remote', 'remove', 'pr-contributor-orca']],
    [['clone', '--', 'https://github.com/stablyai/orca.git', 'orca']],
    [['commit', '--allow-empty', '-m', 'Initial commit']],
    [['init']],
    [['reset', '--mixed', 'a'.repeat(40)]],
    [['reset', '--hard', 'b'.repeat(64)]],
    [['add', '--all', '--', ':(literal)src/file.ts']],
    [['cherry-pick', '--keep-redundant-commits', 'a'.repeat(40)]],
    [['cherry-pick', '--abort']],
    [
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/main:${'b'.repeat(40)}`,
        'origin',
        `${'a'.repeat(40)}:refs/heads/main`
      ]
    ]
  ])('treats %j as mutating', (args) => {
    expect(gitExecMutatesRepository(args)).toBe(true)
  })

  it.each([
    [['-c', 'user.name=Objective Train', 'commit', '--allow-empty', '-m', 'node']],
    [['--no-pager', 'reset', '--mixed', 'a'.repeat(40)]],
    [['--git-dir', '/repo/.git', 'add', '--all', '--', ':(literal)src/file.ts']],
    [['-C', '/repo', 'remote', 'add', 'fork', 'https://github.com/user/repo.git']],
    [['-cuser.name=Objective Train', 'cherry-pick', '--abort']]
  ])('finds mutating commands after Git-global options in %j', (args) => {
    expect(gitExecMutatesRepository(args)).toBe(true)
  })

  it.each([
    // Why: these run on read-heavy paths; misclassifying them would flush the
    // git read cache on every remote probe.
    [['remote']],
    [['remote', '-v']],
    [['remote', 'get-url', 'origin']],
    [['remote', 'show', 'origin']],
    [['rev-parse', '--show-toplevel']],
    [[]],
    [['--no-pager', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--']],
    [['-c', 'color.ui=false', 'show', '--no-patch', 'HEAD']],
    [['--git-dir=/repo/.git', 'rev-parse', '--verify', 'HEAD']]
  ])('treats %j as read-only', (args) => {
    expect(gitExecMutatesRepository(args)).toBe(false)
  })
})
