import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import {
  executeHostedReviewBranchUpdate,
  executeHostedReviewCommitPush,
  type HostedReviewBranchUpdateInput,
  type HostedReviewBranchUpdateResult
} from '../../shared/fork-hosted-review-sitter/git-branch-update'
import {
  createHostedReviewSitterMutationTracker,
  tagHostedReviewPreDispatchError
} from './provider-action-effect'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from '../../shared/git-merge-tree-capability'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getRepoHostedReviewExecutionHostId } from '../source-control/hosted-review-execution-host'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { hasUncommittedChanges } from '../source-control/hosted-review-creation-git-state'
import { resolveGitRouteForHost } from '../providers/execution-host-provider-dispatch'
import { getLocalGitCapabilityCache, getSshGitCapabilityCache } from '../git/git-capability-state'
import { gitExecFileAsync } from '../git/runner'
import { getStatus, bulkStageFiles, commitChanges } from '../git/status'
import { resolveHostedReviewSitterPushTarget } from './provider-push-target'

export type HostedReviewSitterExecutionContext = {
  executionHostId: ExecutionHostId
  connectionId: string | null
  localGitOptions: LocalProjectWorktreeGitOptions
}

export type HostedReviewSitterGitExecution = {
  exec(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }>
  getStatus(signal?: AbortSignal): Promise<GitStatusResult>
  worktreeIsClean(signal?: AbortSignal): Promise<boolean>
  stageFiles(paths: string[], signal?: AbortSignal): Promise<void>
  commit(message: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string }>
  reviewPushTarget(signal?: AbortSignal): Promise<GitPushTarget | null>
  pushCommit(commitSha: string, signal?: AbortSignal): Promise<void>
  currentHeadSha(signal?: AbortSignal): Promise<string>
  remoteHeadSha(signal?: AbortSignal): Promise<string | null>
  remoteRefForBranch(
    branch: string,
    expectedSha: string,
    signal?: AbortSignal
  ): Promise<string | null>
  updateBranch(
    input: Omit<HostedReviewBranchUpdateInput, 'worktreePath' | 'pushRemote'>,
    signal?: AbortSignal,
    onMutationDispatched?: () => void
  ): Promise<HostedReviewBranchUpdateResult>
  simulateConflicts(
    headSha: string,
    baseSha: string,
    signal?: AbortSignal
  ): Promise<'none' | 'present' | 'unknown'>
} & HostedReviewSitterExecutionContext

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  if (signal.reason instanceof Error) {
    throw signal.reason
  }
  const error = new Error('Hosted review operation aborted.')
  error.name = 'AbortError'
  throw error
}

function parseRemoteHead(stdout: string, branch: string): string | null {
  const ref = `refs/heads/${branch}`
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim().split(/\s+/)[1] === ref)
  const sha = line?.trim().split(/\s+/)[0]
  return sha && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
}

function getErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object') {
    return ''
  }
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

async function loadConflicts(
  runGit: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
  capabilities: GitCapabilityCache,
  headSha: string,
  baseSha: string
): Promise<'none' | 'present'> {
  const mergeBase = (await runGit(['merge-base', headSha, baseSha])).stdout.trim()
  const modern = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--merge-base',
    mergeBase,
    headSha,
    baseSha
  ]
  const legacy = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    headSha,
    baseSha
  ]
  const execute = async (args: string[]): Promise<'none' | 'present'> => {
    try {
      const result = await runGit(args)
      return result.stdout.includes('\0') && result.stdout.split('\0').slice(1).some(Boolean)
        ? 'present'
        : 'none'
    } catch (error) {
      if (isUnsupportedMergeTreeWriteTreeError(error)) {
        throw error
      }
      const stdout = getErrorOutput(error, 'stdout')
      if (!stdout) {
        throw error
      }
      return stdout.includes('\0') && stdout.split('\0').slice(1).some(Boolean) ? 'present' : 'none'
    }
  }
  return capabilities.runWithFallback(
    'merge-tree-write-tree',
    () =>
      capabilities.runWithFallback(
        'merge-tree-merge-base',
        () => execute(modern),
        () => execute(legacy),
        isUnsupportedMergeTreeMergeBaseError
      ),
    async () => {
      throw new Error('Git merge-tree --write-tree is unavailable on this execution host.')
    },
    isUnsupportedMergeTreeWriteTreeError
  )
}

export function resolveHostedReviewSitterGitExecution(
  runtime: OrcaRuntimeService,
  store: Store,
  definition: HostedReviewSitterDefinition
): HostedReviewSitterGitExecution {
  void runtime
  const repo = store.getRepo(definition.repoId)
  if (!repo) {
    throw new Error(`Hosted review sitter repository ${definition.repoId} is not registered.`)
  }
  const executionHostId = getRepoHostedReviewExecutionHostId(repo)
  const route = resolveGitRouteForHost(executionHostId)
  if (route.kind === 'runtime') {
    throw new Error(`Hosted review sitter cannot execute on ${route.hostId}.`)
  }
  if (route.kind === 'ssh' && !route.provider) {
    throw new Error(`Git provider unavailable for ${route.hostId}.`)
  }
  const connectionId = route.kind === 'ssh' ? route.connectionId : null
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const remoteProvider = route.kind === 'ssh' ? route.provider : null
  const exec = async (
    args: string[],
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> => {
    throwIfAborted(signal)
    if (remoteProvider) {
      return remoteProvider.exec(args, definition.repoPath, signal ? { signal } : undefined)
    }
    return gitExecFileAsync(args, {
      cwd: definition.repoPath,
      ...localGitOptions,
      ...(signal ? { signal } : {})
    })
  }
  const reviewPushTarget = (signal?: AbortSignal): Promise<GitPushTarget | null> =>
    resolveHostedReviewSitterPushTarget(definition, { connectionId, localGitOptions, exec }, signal)

  return {
    executionHostId,
    connectionId,
    localGitOptions,
    exec,
    getStatus: async (signal) => {
      throwIfAborted(signal)
      return remoteProvider
        ? remoteProvider.getStatus(definition.repoPath, signal ? { signal } : undefined)
        : getStatus(definition.repoPath, {
            ...localGitOptions,
            sharedLinkPaths: repo.symlinkPaths,
            ...(signal ? { signal } : {})
          })
    },
    worktreeIsClean: async (signal) => {
      throwIfAborted(signal)
      return !(await hasUncommittedChanges(definition.repoPath, executionHostId, {
        localGitExecOptions: localGitOptions,
        sharedLinkPaths: repo.symlinkPaths
      }))
    },
    stageFiles: async (paths, signal) => {
      throwIfAborted(signal)
      return remoteProvider
        ? remoteProvider.bulkStageFiles(definition.repoPath, paths)
        : bulkStageFiles(definition.repoPath, paths, { ...localGitOptions, signal })
    },
    commit: async (message, signal) => {
      throwIfAborted(signal)
      return remoteProvider
        ? remoteProvider.commit(definition.repoPath, message)
        : commitChanges(definition.repoPath, message, { ...localGitOptions, signal })
    },
    reviewPushTarget,
    pushCommit: async (commitSha, signal) => {
      const tracker = createHostedReviewSitterMutationTracker()
      try {
        throwIfAborted(signal)
        const pushTarget = await reviewPushTarget(signal)
        if (!pushTarget?.remoteUrl) {
          throw new Error('The hosted review source repository push target is unverifiable.')
        }
        throwIfAborted(signal)
        const input = {
          worktreePath: definition.repoPath,
          branch: pushTarget.branchName,
          pushUrl: pushTarget.remoteUrl,
          commitSha
        }
        if (remoteProvider) {
          throwIfAborted(signal)
          tracker.markDispatched()
          await remoteProvider.hostedReviewSitter.pushCommit(input, signal)
        } else {
          await executeHostedReviewCommitPush(
            (args) => exec(args, signal),
            input,
            () => tracker.markDispatched()
          )
        }
      } catch (error) {
        if (!tracker.dispatched) {
          throw tagHostedReviewPreDispatchError(error)
        }
        throw error
      }
    },
    currentHeadSha: async (signal) =>
      (await exec(['rev-parse', '--verify', 'HEAD'], signal)).stdout.trim(),
    remoteHeadSha: async (signal) => {
      const pushTarget = await reviewPushTarget(signal)
      if (!pushTarget) {
        return null
      }
      if (!pushTarget.remoteUrl) {
        return null
      }
      const result = await exec(
        ['ls-remote', '--heads', pushTarget.remoteUrl, `refs/heads/${pushTarget.branchName}`],
        signal
      )
      return parseRemoteHead(result.stdout, pushTarget.branchName)
    },
    remoteRefForBranch: async (branch, expectedSha, signal) => {
      await exec(['check-ref-format', '--branch', branch], signal)
      const remotes = (await exec(['remote'], signal)).stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
      for (const remote of remotes) {
        const result = await exec(['ls-remote', '--heads', remote, `refs/heads/${branch}`], signal)
        if (parseRemoteHead(result.stdout, branch) === expectedSha) {
          return `${remote}/${branch}`
        }
      }
      return null
    },
    updateBranch: async (input, signal, onMutationDispatched) => {
      throwIfAborted(signal)
      const pushTarget = await reviewPushTarget(signal)
      if (!pushTarget?.remoteUrl || pushTarget.branchName !== input.branch) {
        throw new Error('The hosted review source repository push target is unverifiable.')
      }
      const completeInput = {
        ...input,
        worktreePath: definition.repoPath,
        pushRemote: pushTarget.remoteUrl
      }
      if (remoteProvider) {
        onMutationDispatched?.()
        return remoteProvider.hostedReviewSitter.updateBranch(completeInput, signal)
      }
      const capabilities = getLocalGitCapabilityCache({
        cwd: definition.repoPath,
        wslDistro: localGitOptions.wslDistro
      })
      return executeHostedReviewBranchUpdate(
        (args) => exec(args, signal),
        capabilities,
        completeInput,
        signal,
        (args) =>
          gitExecFileAsync(args, {
            cwd: definition.repoPath,
            ...localGitOptions,
            timeout: 30_000
          }),
        onMutationDispatched
      )
    },
    simulateConflicts: async (headSha, baseSha, signal) => {
      throwIfAborted(signal)
      const capabilities = remoteProvider
        ? getSshGitCapabilityCache(remoteProvider)
        : getLocalGitCapabilityCache({
            cwd: definition.repoPath,
            wslDistro: localGitOptions.wslDistro
          })
      return loadConflicts((args) => exec(args, signal), capabilities, headSha, baseSha).catch(
        () => 'unknown'
      )
    }
  }
}
