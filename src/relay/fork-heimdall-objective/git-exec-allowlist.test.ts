import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_PATH_MODES_ALIAS,
  OBJECTIVE_PATH_MODES_ALIAS_CONFIG,
  OBJECTIVE_SYMLINK_OID_ALIAS,
  OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG
} from '../../shared/fork-heimdall/objective-git-exec-shapes'
import { validateGitExecArgs } from '../git-exec-validator'

const SHA1 = 'a'.repeat(40)
const SHA256 = 'b'.repeat(64)

describe('Heimdall objective git.exec admission', () => {
  it.each([
    [['rev-parse', '--verify', '--quiet', `${SHA1}^{commit}`]],
    [['merge-base', '--is-ancestor', SHA1, SHA256]],
    [['merge-base', SHA256, SHA1]],
    [['status', '--porcelain=v2', '-z', '--untracked-files=all', '--']],
    [
      [
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
        '--'
      ]
    ],
    [['ls-files', '--unmerged', '-z']],
    [
      [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ':(literal)dist/report.bin'
      ]
    ],
    [
      [
        'log',
        '--format=%H',
        '--no-merges',
        '--first-parent',
        '--max-count=32',
        '--skip=0',
        `${SHA1}..${SHA256}`
      ]
    ],
    [['hash-object', '--', 'src/file with space.ts']],
    [['ls-tree', '-z', SHA1]],
    [['ls-tree', '-z', SHA1, '--', ':(literal)src/file with space.ts']],
    [['ls-tree', '-r', '-z', SHA1, '--', ':(literal)src']],
    [['-c', OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG, OBJECTIVE_SYMLINK_OID_ALIAS, '--', 'link']],
    [
      [
        '-c',
        OBJECTIVE_PATH_MODES_ALIAS_CONFIG,
        OBJECTIVE_PATH_MODES_ALIAS,
        '--',
        'src/one.ts',
        'src/two.ts'
      ]
    ],
    [
      [
        '-C',
        'submodules/child',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none'
      ]
    ],
    [['-C', 'nested', '-C', 'child', 'hash-object', '--', 'file.txt']],
    [['reset', '--mixed', SHA1]],
    [['reset', '--hard', SHA256]],
    [['add', '--all', '--', ':(literal)src/one.ts', ':(literal)-leading-option.ts']],
    [['add', '--all', '--force', '--', ':(literal)dist/report.bin']],
    [['commit', '--allow-empty', '-m', 'Implement node\n\nOrca-Heimdall-Task: node-a']],
    [['add', '--', ':(literal)src/one.ts', ':(literal)src/file with space.ts']],
    [
      [
        'commit',
        '-m',
        'Land objective\n\nOrca-Heimdall-Attempt: attempt-a',
        '--',
        ':(literal)src/one.ts'
      ]
    ],
    [['cat-file', '-e', `${SHA1}^{commit}`]],
    [['rev-list', '--parents', '-n', '1', 'HEAD']],
    [
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/team/objective:${SHA256}`,
        'origin',
        `${SHA1}:refs/heads/team/objective`
      ]
    ],
    [
      [
        'push',
        '--porcelain',
        '--force-with-lease=refs/heads/new-objective:',
        'origin',
        `${SHA1}:refs/heads/new-objective`
      ]
    ],
    [['cherry-pick', '--keep-redundant-commits', SHA1]],
    [['cherry-pick', '--abort']],
    [['show', '--no-patch', '--format=%an%x00%ae%x00%aI%x00%B', SHA256]],
    [['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', SHA1, SHA256]],
    [['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', `${SHA1}^`, SHA1]],
    [['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', `${SHA1}^`, SHA1]],
    [['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', SHA1, SHA256]],
    [['cherry', SHA1, SHA256, SHA1]]
  ])('allows the exact objective argv %j', (args) => {
    expect(() => validateGitExecArgs(args)).not.toThrow()
  })

  it.each([
    [['status', '--porcelain=v2', '-z', '--untracked-files=all']],
    [['status', '--porcelain=v2', '-z', '--ignored', '--untracked-files=all', '--']],
    [['reset', '--soft', SHA1]],
    [['reset', '--mixed', 'HEAD']],
    [['reset', '--hard', `${SHA1}^`]],
    [['reset', '--mixed', 'a'.repeat(41)]],
    [['add', '--all', '--']],
    [['add', '--all', '--force', '--']],
    [['add', '--force', '--all', '--', ':(literal)dist/report.bin']],
    [['add', '--all', '--force', '--', 'dist/report.bin']],
    [['add', '--all', '--', 'src/one.ts']],
    [['add', '--all', '--', ':(literal)../outside.ts']],
    [['add', '--all', '--', ':(literal)/tmp/outside.ts']],
    [['add', '--all', '--', ':(literal)C:\\outside.ts']],
    [['add', '--all', '--', ':(literal)C:outside.ts']],
    [['add', '--', ':(literal)../outside.ts']],
    [['add', '--', ':(literal).orca/watcher.json']],
    [['commit', '-m', 'Land objective', 'src/file.ts']],
    [['commit', '-m', '', '--', ':(literal)src/file.ts']],
    [['commit', '-m', 'Land objective', '--', ':(literal).orca/watcher.json']],
    [['cat-file', '-e', 'HEAD^{commit}']],
    [['rev-list', '--parents', '-n', '2', 'HEAD']],
    [
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/other:${SHA256}`,
        'origin',
        `${SHA1}:refs/heads/objective`
      ]
    ],
    [
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/../escape:${SHA256}`,
        'origin',
        `${SHA1}:refs/heads/../escape`
      ]
    ],
    [
      [
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/objective:${SHA256}`,
        '--upload-pack=evil',
        `${SHA1}:refs/heads/objective`
      ]
    ],
    [['hash-object', '--', '../outside']],
    [['hash-object', '--', '/etc/passwd']],
    [['hash-object', '--', '.orca/watcher.json']],
    [['hash-object', '--', 'nested/.git/config']],
    [['hash-object', 'src/file.ts']],
    [['ls-tree', '-z', 'HEAD']],
    [['ls-tree', '-z', SHA1, '--', 'src/file.ts']],
    [['--literal-pathspecs', 'ls-tree', '-z', SHA1]],
    [['-c', 'core.sshCommand=evil', 'status', '--porcelain=v2']],
    [['-c', `${OBJECTIVE_SYMLINK_OID_ALIAS_CONFIG} `, OBJECTIVE_SYMLINK_OID_ALIAS, '--', 'link']],
    [['-C', '../outside', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--']],
    [['-C', 'nested', '--no-pager', 'status', '--porcelain=v2', '-z']],
    [['cherry-pick', '--keep-redundant-commits', 'HEAD']],
    [['cherry-pick', '--no-commit', SHA1]],
    [['cherry-pick', '--abort', SHA1]],
    [['diff', '--name-only', '--diff-filter=U', '-z', '--', 'src/one.ts']],
    [['show', '--no-patch', '--format=%B', SHA1]],
    [['show', '--no-patch', '--format=%an%x00%ae%x00%aI%x00%B', 'HEAD']],
    [['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD^', SHA1]],
    [['diff-tree', '--no-commit-id', '--name-only', '-r', SHA1, SHA256]],
    [['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', SHA1, SHA256]],
    [['cherry', SHA1, SHA256, 'HEAD']]
  ])('rejects malformed or widened objective argv %j', (args) => {
    expect(() => validateGitExecArgs(args)).toThrow()
  })

  it.each([
    [['diff', '--name-only', '--diff-filter=U', '-z', '--'], 'restricted to staged changes'],
    [['diff', '--cached', '--', 'src/one.ts'], 'git diff flag not allowed'],
    [['config', '--list', '--add', 'bad'], 'git config write operations'],
    [['branch', '-D', 'main'], 'Destructive git branch flags']
  ])('does not bypass incumbent validation for %j', (args, message) => {
    expect(() => validateGitExecArgs(args)).toThrow(message)
  })

  it('keeps staged path batches within the train batch bound', () => {
    const paths = Array.from({ length: 201 }, (_, index) => `:(literal)src/${index}.ts`)
    expect(() => validateGitExecArgs(['add', '--all', '--', ...paths])).toThrow(
      'git subcommand not allowed: add'
    )
  })

  it('keeps landing staging batches within the shared path bound', () => {
    const paths = Array.from({ length: 201 }, (_, index) => `:(literal)src/${index}.ts`)
    expect(() => validateGitExecArgs(['add', '--', ...paths.slice(0, 200)])).not.toThrow()
    expect(() => validateGitExecArgs(['add', '--', ...paths])).toThrow(
      'git subcommand not allowed: add'
    )
  })

  it('keeps exact objective read batches within the shared path bound', () => {
    const paths = Array.from({ length: 201 }, (_, index) => `src/${index}.ts`)
    const prefix = ['-c', OBJECTIVE_PATH_MODES_ALIAS_CONFIG, OBJECTIVE_PATH_MODES_ALIAS, '--']
    expect(() => validateGitExecArgs([...prefix, ...paths.slice(0, 200)])).not.toThrow()
    expect(() => validateGitExecArgs([...prefix, ...paths])).toThrow(
      'Global git flags before the subcommand are not allowed'
    )
  })
})
