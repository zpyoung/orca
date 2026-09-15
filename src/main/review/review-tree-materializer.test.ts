import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getReviewTreePath,
  materializeReviewTree,
  removeMaterializedReviewTree,
  type ReviewTreeGitExecutor
} from './review-tree-materializer'

const repoPath = join('workspace', 'repo')
const runDirectory = join(repoPath, '.orca-review', 'runs', '0123456789abcdef')
const headOid = '0123456789abcdef0123456789abcdef01234567'
const treePath = join(runDirectory, 'artifact', 'tree')

describe('review tree materializer', () => {
  it('derives the tree path with platform path joining', () => {
    expect(getReviewTreePath(runDirectory)).toBe(treePath)
  })

  it('adds a detached worktree for the resolved head object', async () => {
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockResolvedValue({ stdout: '', stderr: '' })

    await expect(materializeReviewTree({ gitExec, repoPath, runDirectory, headOid })).resolves.toBe(
      treePath
    )

    expect(gitExec).toHaveBeenCalledWith(
      ['worktree', 'add', '--detach', treePath, headOid],
      repoPath
    )
  })

  it('preserves accepted global git options before the worktree subcommand', async () => {
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockResolvedValue({ stdout: '', stderr: '' })
    const gitGlobalArgs = ['-c', 'core.longpaths=true']

    await materializeReviewTree({ gitExec, repoPath, runDirectory, headOid, gitGlobalArgs })
    await removeMaterializedReviewTree({ gitExec, repoPath, runDirectory, gitGlobalArgs })

    expect(gitExec).toHaveBeenNthCalledWith(
      1,
      ['-c', 'core.longpaths=true', 'worktree', 'add', '--detach', treePath, headOid],
      repoPath
    )
    expect(gitExec).toHaveBeenNthCalledWith(
      2,
      ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', treePath],
      repoPath
    )
  })

  it('removes the materialized tree with force', async () => {
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockResolvedValue({ stdout: '', stderr: '' })

    await removeMaterializedReviewTree({ gitExec, repoPath, runDirectory })

    expect(gitExec).toHaveBeenCalledWith(['worktree', 'remove', '--force', treePath], repoPath)
  })

  it('tolerates cleanup after the materialized tree is already absent', async () => {
    const missing = Object.assign(new Error('git worktree remove failed'), {
      stderr: `fatal: '${treePath}' is not a working tree\n`
    })
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockRejectedValue(missing)

    await expect(
      removeMaterializedReviewTree({ gitExec, repoPath, runDirectory })
    ).resolves.toBeUndefined()
  })

  it('recognizes Git-for-Windows path separators in an already-absent error', async () => {
    const windowsRunDirectory = 'C:\\repo\\.orca-review\\runs\\0123456789abcdef'
    const expectedTreePath = getReviewTreePath(windowsRunDirectory)
    const reportedTreePath = expectedTreePath.replaceAll('\\', '/')
    const missing = Object.assign(new Error('git worktree remove failed'), {
      stderr: `fatal: '${reportedTreePath}' is not a working tree\n`
    })
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockRejectedValue(missing)

    await expect(
      removeMaterializedReviewTree({ gitExec, repoPath, runDirectory: windowsRunDirectory })
    ).resolves.toBeUndefined()
  })

  it('does not swallow unrelated cleanup failures', async () => {
    const failure = Object.assign(new Error('git worktree remove failed'), {
      stderr: 'fatal: cannot remove a locked working tree\n'
    })
    const gitExec = vi.fn<ReviewTreeGitExecutor>().mockRejectedValue(failure)

    await expect(removeMaterializedReviewTree({ gitExec, repoPath, runDirectory })).rejects.toBe(
      failure
    )
  })
})
