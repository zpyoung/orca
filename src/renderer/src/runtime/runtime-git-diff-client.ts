import type {
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitDiffResult
} from '../../../shared/git-diff-compare-types'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function getRuntimeGitDiff(
  context: RuntimeGitContext,
  args: {
    filePath: string
    staged: boolean
    compareAgainstHead?: boolean
    signal?: AbortSignal
  }
): Promise<GitDiffResult> {
  const { signal, ...diffArgs } = args
  if (signal?.aborted) {
    throw createGitDiffAbortError()
  }
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return callLocalGitDiff(
      {
        worktreePath: resolveLocalWorktreePath(context),
        ...diffArgs,
        connectionId: context.connectionId
      },
      signal
    )
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.diff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...diffArgs },
    { timeoutMs: 15_000, signal }
  )
}

let nextGitDiffRequestToken = 0

function createGitDiffAbortError(): Error {
  const error = new Error('Git diff request aborted')
  error.name = 'AbortError'
  return error
}

function callLocalGitDiff(
  args: Parameters<Window['api']['git']['diff']>[0],
  signal?: AbortSignal
): Promise<GitDiffResult> {
  if (!signal) {
    return window.api.git.diff(args)
  }
  if (signal.aborted) {
    return Promise.reject(createGitDiffAbortError())
  }
  const requestToken = `git-diff-${Date.now()}-${++nextGitDiffRequestToken}`
  const request = Promise.withResolvers<GitDiffResult>()
  let settled = false
  const finish = (complete: () => void): void => {
    if (settled) {
      return
    }
    settled = true
    signal.removeEventListener('abort', cancel)
    complete()
  }
  const cancel = (): void => {
    void window.api.git.cancelDiff({ requestToken }).catch(() => {})
    finish(() => request.reject(createGitDiffAbortError()))
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    void window.api.git.diff({ ...args, requestToken }).then(
      (diff) =>
        finish(() => {
          if (signal.aborted) {
            request.reject(createGitDiffAbortError())
            return
          }
          request.resolve(diff)
        }),
      (error) => finish(() => request.reject(error))
    )
  } catch (error) {
    finish(() => request.reject(error))
  }
  return request.promise
}

export async function getRuntimeGitBranchCompare(
  context: RuntimeGitContext,
  baseRef: string,
  admissionTier: 'interactive' | 'background' = 'interactive'
): Promise<GitBranchCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchCompare({
      worktreePath: resolveLocalWorktreePath(context),
      baseRef,
      connectionId: context.connectionId,
      admissionTier
    })
  }
  return callRuntimeRpc<GitBranchCompareResult>(
    target,
    'git.branchCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), baseRef, admissionTier },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitCompare(
  context: RuntimeGitContext,
  commitId: string
): Promise<GitCommitCompareResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitCompare({
      worktreePath: resolveLocalWorktreePath(context),
      commitId,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitCommitCompareResult>(
    target,
    'git.commitCompare',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), commitId },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitBranchDiff(
  context: RuntimeGitContext,
  args: {
    compare: { baseRef: string; baseOid: string; headOid: string; mergeBase: string }
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.branchDiff({
      worktreePath: resolveLocalWorktreePath(context),
      compare: args.compare,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.branchDiff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitCommitDiff(
  context: RuntimeGitContext,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  }
): Promise<GitDiffResult> {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.commitDiff({
      worktreePath: resolveLocalWorktreePath(context),
      commitOid: args.commitOid,
      parentOid: args.parentOid,
      filePath: args.filePath,
      oldPath: args.oldPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<GitDiffResult>(
    target,
    'git.commitDiff',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...args },
    { timeoutMs: 15_000 }
  )
}
