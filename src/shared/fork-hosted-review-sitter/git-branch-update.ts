import { randomUUID } from 'node:crypto'
import type { GitCapabilityCache } from '../git-capability-cache'
import { isNoWriteFetchHeadUnsupportedError } from '../git-fetch-head-capability'
import { resolveGitRemoteRebaseSource } from '../git-rebase-source'
import { runWithGitWorktreeOperationLock } from '../git-worktree-operation-lock'
export const HOSTED_REVIEW_BRANCH_UPDATE_RPC_TIMEOUT_MS = 135_000
export const HOSTED_REVIEW_COMMIT_PUSH_RPC_TIMEOUT_MS = 60_000

export type HostedReviewCommitPushInput = {
  worktreePath: string
  branch: string
  pushUrl: string
  commitSha: string
}

export type HostedReviewBranchUpdateInput = {
  worktreePath: string
  branch: string
  pushRemote: string
  baseRef: string
  expectedHeadSha: string
  expectedBaseSha: string
  mode: 'merge-base-update' | 'rebase'
}

export type HostedReviewBranchUpdateResult = {
  resultingHeadSha: string
}

export type HostedReviewBranchUpdateGitRunner = (
  args: string[]
) => Promise<{ stdout: string; stderr?: string }>

function assertObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`Invalid ${label}.`)
  }
}

export function assertHostedReviewBranchUpdateInput(
  value: unknown
): asserts value is HostedReviewBranchUpdateInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid hosted review branch update request.')
  }
  const input = value as Record<string, unknown>
  for (const key of [
    'worktreePath',
    'branch',
    'pushRemote',
    'baseRef',
    'expectedHeadSha',
    'expectedBaseSha'
  ]) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new Error(`Invalid hosted review branch update ${key}.`)
    }
  }
  if (input.mode !== 'merge-base-update' && input.mode !== 'rebase') {
    throw new Error('Invalid hosted review branch update mode.')
  }
}

export function assertHostedReviewCommitPushInput(
  value: unknown
): asserts value is HostedReviewCommitPushInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid hosted review commit push request.')
  }
  const input = value as Record<string, unknown>
  for (const key of ['worktreePath', 'branch', 'pushUrl', 'commitSha']) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new Error(`Invalid hosted review commit push ${key}.`)
    }
  }
  assertObjectId(input.commitSha as string, 'publication commit SHA')
}

export async function executeHostedReviewCommitPush(
  runGit: HostedReviewBranchUpdateGitRunner,
  input: HostedReviewCommitPushInput,
  onMutationDispatched?: () => void
): Promise<void> {
  assertHostedReviewCommitPushInput(input)
  await runGit(['check-ref-format', '--branch', input.branch])
  await runGit(['cat-file', '-e', `${input.commitSha}^{commit}`])
  onMutationDispatched?.()
  await runGit(['push', input.pushUrl, `${input.commitSha}:refs/heads/${input.branch}`])
}

async function readRemoteBranchHead(
  runGit: HostedReviewBranchUpdateGitRunner,
  remote: string,
  branch: string
): Promise<string | null> {
  const remoteRef = `refs/heads/${branch}`
  const lines = (await runGit(['ls-remote', '--heads', remote, remoteRef])).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  const match = lines.find((line) => line.split(/\s+/)[1] === remoteRef)
  const oid = match?.split(/\s+/)[0]
  return oid && /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null
}

async function hasInProgressRef(
  runGit: HostedReviewBranchUpdateGitRunner,
  ref: 'MERGE_HEAD' | 'REBASE_HEAD'
): Promise<boolean> {
  try {
    return Boolean((await runGit(['rev-parse', '--verify', '--quiet', ref])).stdout.trim())
  } catch {
    return false
  }
}

async function abortIncompleteUpdate(
  runGit: HostedReviewBranchUpdateGitRunner,
  mode: HostedReviewBranchUpdateInput['mode']
): Promise<void> {
  await runGit(mode === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort'])
}

async function runUpdateUnlocked(
  runGit: HostedReviewBranchUpdateGitRunner,
  cleanupRunGit: HostedReviewBranchUpdateGitRunner,
  capabilities: GitCapabilityCache,
  input: HostedReviewBranchUpdateInput,
  onMutationDispatched?: () => void
): Promise<HostedReviewBranchUpdateResult> {
  assertObjectId(input.expectedHeadSha, 'expected review head SHA')
  assertObjectId(input.expectedBaseSha, 'expected base SHA')
  await runGit(['check-ref-format', '--branch', input.branch])

  const branch = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim()
  if (branch !== input.branch) {
    throw new Error(`Expected review branch ${input.branch}, found ${branch || 'detached HEAD'}.`)
  }
  const headSha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  if (headSha !== input.expectedHeadSha) {
    throw new Error(`Review head changed from ${input.expectedHeadSha} to ${headSha || 'unknown'}.`)
  }
  if (
    (await hasInProgressRef(runGit, 'MERGE_HEAD')) ||
    (await hasInProgressRef(runGit, 'REBASE_HEAD'))
  ) {
    throw new Error('The review worktree already has a merge or rebase in progress.')
  }
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=normal'])
  if (status.stdout.length > 0) {
    throw new Error('The review worktree has local changes.')
  }

  const pushRemote = input.pushRemote
  const remoteHead = await readRemoteBranchHead(runGit, pushRemote, input.branch)
  if (remoteHead !== input.expectedHeadSha) {
    throw new Error(
      `Remote review head changed from ${input.expectedHeadSha} to ${remoteHead ?? 'unknown'}.`
    )
  }

  const base = await resolveGitRemoteRebaseSource(runGit, input.baseRef)
  const fetchedBaseRef = `refs/orca/hosted-review-sitter/${randomUUID()}`
  const fetchArgs = [
    base.remoteName,
    `+refs/heads/${base.branchName}:${fetchedBaseRef}`,
    `+refs/heads/${base.branchName}:refs/remotes/${base.displayName}`
  ]

  let result: HostedReviewBranchUpdateResult
  try {
    onMutationDispatched?.()
    await capabilities.runWithFallback(
      'fetch-no-write-fetch-head',
      () => runGit(['fetch', '--no-write-fetch-head', ...fetchArgs]),
      () => runGit(['fetch', ...fetchArgs]),
      isNoWriteFetchHeadUnsupportedError
    )
    const fetchedBaseSha = (await runGit(['rev-parse', '--verify', fetchedBaseRef])).stdout.trim()
    if (fetchedBaseSha !== input.expectedBaseSha) {
      throw new Error(
        `Review base changed from ${input.expectedBaseSha} to ${fetchedBaseSha || 'unknown'}.`
      )
    }

    try {
      await runGit(
        input.mode === 'rebase'
          ? ['rebase', fetchedBaseRef]
          : ['merge', '--no-edit', fetchedBaseRef]
      )
    } catch (error) {
      try {
        await abortIncompleteUpdate(cleanupRunGit, input.mode)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Hosted review branch update failed and Git cleanup also failed.'
        )
      }
      throw error
    }

    const resultingHeadSha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const remoteRef = `refs/heads/${input.branch}`
    const forceLease =
      input.mode === 'rebase' ? [`--force-with-lease=${remoteRef}:${input.expectedHeadSha}`] : []
    try {
      await runGit(['push', ...forceLease, pushRemote, `${resultingHeadSha}:${remoteRef}`])
    } catch (pushError) {
      // A throwing push is not proof the push did not land, so rewind only once the remote is
      // re-read at the pre-update head; otherwise the rewrite stays and the ledger escalates.
      let remoteAfterPush: string | null
      try {
        remoteAfterPush = await readRemoteBranchHead(cleanupRunGit, pushRemote, input.branch)
      } catch {
        throw pushError
      }
      if (remoteAfterPush !== input.expectedHeadSha) {
        throw pushError
      }
      try {
        await cleanupRunGit(['reset', '--hard', input.expectedHeadSha])
      } catch (cleanupError) {
        throw new AggregateError(
          [pushError, cleanupError],
          'Hosted review branch update could not publish and the local rewind also failed.'
        )
      }
      throw pushError
    }
    result = { resultingHeadSha }
  } catch (updateError) {
    try {
      await cleanupRunGit(['update-ref', '-d', fetchedBaseRef])
    } catch (cleanupError) {
      throw new AggregateError(
        [updateError, cleanupError],
        'Hosted review branch update failed and temporary ref cleanup also failed.'
      )
    }
    throw updateError
  }

  try {
    await cleanupRunGit(['update-ref', '-d', fetchedBaseRef])
  } catch (cleanupError) {
    process.emitWarning(cleanupError instanceof Error ? cleanupError : String(cleanupError), {
      code: 'HOSTED_REVIEW_TEMP_REF_CLEANUP_FAILED'
    })
  }
  return result
}

export function executeHostedReviewBranchUpdate(
  runGit: HostedReviewBranchUpdateGitRunner,
  capabilities: GitCapabilityCache,
  input: HostedReviewBranchUpdateInput,
  signal?: AbortSignal,
  cleanupRunGit: HostedReviewBranchUpdateGitRunner = runGit,
  onMutationDispatched?: () => void
): Promise<HostedReviewBranchUpdateResult> {
  return runWithGitWorktreeOperationLock(input.worktreePath, signal, () =>
    runUpdateUnlocked(runGit, cleanupRunGit, capabilities, input, onMutationDispatched)
  )
}
