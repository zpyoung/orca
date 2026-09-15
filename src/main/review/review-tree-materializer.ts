import { join } from 'node:path'

export type ReviewTreeGitExecutor = (args: string[], cwd: string) => Promise<unknown>

export type ReviewTreeGitOptions = {
  gitExec: ReviewTreeGitExecutor
  repoPath: string
  runDirectory: string
  gitGlobalArgs?: readonly string[]
}

export type MaterializeReviewTreeOptions = ReviewTreeGitOptions & {
  headOid: string
}

export function getReviewTreePath(runDirectory: string): string {
  return join(runDirectory, 'artifact', 'tree')
}

function buildGitArgs(
  globalArgs: readonly string[] | undefined,
  args: readonly string[]
): string[] {
  return [...(globalArgs ?? []), ...args]
}

export async function materializeReviewTree(
  options: MaterializeReviewTreeOptions
): Promise<string> {
  const treePath = getReviewTreePath(options.runDirectory)
  await options.gitExec(
    buildGitArgs(options.gitGlobalArgs, ['worktree', 'add', '--detach', treePath, options.headOid]),
    options.repoPath
  )
  return treePath
}

function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return error instanceof Error ? error.message : String(error)
  }
  const candidate = error as { message?: unknown; stderr?: unknown }
  const stderr = Buffer.isBuffer(candidate.stderr)
    ? candidate.stderr.toString('utf8')
    : typeof candidate.stderr === 'string'
      ? candidate.stderr
      : ''
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return `${message}\n${stderr}`
}

function isMissingReviewWorktree(error: unknown, treePath: string): boolean {
  const text = errorText(error)
  const reportedPaths = new Set([treePath, treePath.replaceAll('\\', '/')])
  return [...reportedPaths].some(
    (reportedPath) =>
      text.includes(`fatal: '${reportedPath}' is not a working tree`) ||
      text.includes(`fatal: "${reportedPath}" is not a working tree`)
  )
}

export async function removeMaterializedReviewTree(options: ReviewTreeGitOptions): Promise<void> {
  const treePath = getReviewTreePath(options.runDirectory)
  try {
    await options.gitExec(
      buildGitArgs(options.gitGlobalArgs, ['worktree', 'remove', '--force', treePath]),
      options.repoPath
    )
  } catch (error) {
    if (!isMissingReviewWorktree(error, treePath)) {
      throw error
    }
  }
}
