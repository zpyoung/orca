import type {
  HostedReviewSnapshot,
  HostedReviewSitterActionResult,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import type { HostedReviewSitterMutationTracker } from './provider-action-effect'
import {
  ENQUEUE_PULL_REQUEST_MUTATION,
  loadGitHubState,
  runGitHubApi,
  stringValue,
  type GitHubState,
  type ProviderAction
} from './provider-github-read'

const MERGE_QUEUE_METHOD_QUERY = `
query($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    mergeQueue(branch: $branch) { configuration { mergeMethod } }
  }
}`

function assertExpectedHead(snapshot: HostedReviewSnapshot, expectedHead: string): void {
  if (snapshot.freshness !== 'live' || snapshot.headSha !== expectedHead) {
    throw new Error(
      `GitHub review head changed from ${expectedHead} to ${snapshot.headSha || 'unknown'}.`
    )
  }
}

function assertMergeGates(snapshot: HostedReviewSnapshot, expectedHead: string): void {
  assertExpectedHead(snapshot, expectedHead)
  if (
    snapshot.lifecycle !== 'open' ||
    snapshot.draft ||
    snapshot.providerReadiness.verdict !== 'ready' ||
    snapshot.conflicts !== 'none' ||
    !snapshot.checksComplete ||
    snapshot.queue.membership === 'unknown' ||
    snapshot.checks.some(
      (check) => check.required && (check.headSha !== expectedHead || check.state !== 'passed')
    )
  ) {
    throw new Error('GitHub merge gates are no longer satisfied.')
  }
}

async function assertQueueMergeMethod(
  definition: HostedReviewSitterDefinition,
  state: GitHubState,
  signal?: AbortSignal
): Promise<void> {
  if (definition.mergeMethod === null) {
    return
  }
  const response = JSON.parse(
    await runGitHubApi(
      state.ownerRepo,
      state.ghOptions,
      'graphql',
      [
        'api',
        'graphql',
        '-f',
        `query=${MERGE_QUEUE_METHOD_QUERY}`,
        '-f',
        `owner=${state.ownerRepo.owner}`,
        '-f',
        `repo=${state.ownerRepo.repo}`,
        '-f',
        `branch=${state.baseRefName}`
      ],
      signal
    )
  ) as {
    data?: { repository?: { mergeQueue?: { configuration?: { mergeMethod?: unknown } } | null } }
    errors?: unknown[]
  }
  const method = stringValue(
    response.data?.repository?.mergeQueue?.configuration?.mergeMethod
  ).toLowerCase()
  if (response.errors?.length || !['merge', 'rebase', 'squash'].includes(method)) {
    throw new Error('GitHub merge queue method is not verifiable.')
  }
  if (method !== definition.mergeMethod) {
    throw new Error(
      `GitHub merge queue uses ${method}, not the sitter-pinned ${definition.mergeMethod} method.`
    )
  }
}

function parseRerunTargets(checkIds: readonly string[]): {
  workflowIds: number[]
  checkIds: number[]
} {
  const workflowIds = new Set<number>()
  const directCheckIds = new Set<number>()
  for (const checkId of checkIds) {
    const workflow = checkId.match(/^workflow:(\d+):check:/)
    const direct = checkId.match(/^check:(\d+)$/)
    if (workflow) {
      workflowIds.add(Number(workflow[1]))
    } else if (direct) {
      directCheckIds.add(Number(direct[1]))
    }
  }
  return { workflowIds: [...workflowIds], checkIds: [...directCheckIds] }
}

async function rerunChecks(
  state: GitHubState,
  action: Extract<ProviderAction, { kind: 'rerun-check' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertExpectedHead(state.snapshot, action.headSha)
  const current = state.snapshot.checks.filter(
    (check) =>
      action.checkIds.includes(check.checkId) && action.observationIds.includes(check.observationId)
  )
  if (
    current.length !== action.checkIds.length ||
    current.some((check) => check.state !== 'failed')
  ) {
    throw new Error('GitHub check attempts changed before rerun.')
  }
  const targets = parseRerunTargets(action.checkIds)
  if (targets.workflowIds.length === 0 && targets.checkIds.length === 0) {
    throw new Error('GitHub returned no rerunnable failed checks.')
  }
  for (const workflowId of targets.workflowIds) {
    throwIfAborted(signal)
    await runGitHubApi(
      state.ownerRepo,
      state.ghOptions,
      'core',
      [
        'api',
        '-X',
        'POST',
        `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/actions/runs/${workflowId}/rerun-failed-jobs`
      ],
      signal,
      () => tracker.markDispatched()
    )
  }
  for (const checkId of targets.checkIds) {
    throwIfAborted(signal)
    await runGitHubApi(
      state.ownerRepo,
      state.ghOptions,
      'core',
      [
        'api',
        '-X',
        'POST',
        `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/check-runs/${checkId}/rerequest`
      ],
      signal,
      () => tracker.markDispatched()
    )
  }
  return { kind: 'rerun-requested' }
}

function waitForUpdatePoll(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = (): void => {
    clearTimeout(timeout)
    try {
      throwIfAborted(signal)
    } catch (error) {
      reject(error)
    }
  }
  const timeout = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, 500)
  signal?.addEventListener('abort', onAbort, { once: true })
  return promise
}

async function updateBranch(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  state: GitHubState,
  action: Extract<ProviderAction, { kind: 'update-branch' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertExpectedHead(state.snapshot, action.headSha)
  if (state.snapshot.baseSha !== action.baseSha) {
    throw new Error('GitHub review base changed before branch update.')
  }
  if (action.mode === 'rebase') {
    const baseRef = await git.remoteRefForBranch(state.baseRefName, action.baseSha, signal)
    throwIfAborted(signal)
    if (!baseRef) {
      throw new Error('The current GitHub base commit is not available from a configured remote.')
    }
    const result = await git.updateBranch(
      {
        branch: definition.branch,
        baseRef,
        expectedHeadSha: action.headSha,
        expectedBaseSha: action.baseSha,
        mode: 'rebase'
      },
      signal,
      () => tracker.markDispatched()
    )
    return { kind: 'published', resultingHeadSha: result.resultingHeadSha }
  }
  throwIfAborted(signal)
  await runGitHubApi(
    state.ownerRepo,
    state.ghOptions,
    'core',
    [
      'api',
      '-X',
      'PUT',
      `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/pulls/${definition.reviewNumber}/update-branch`,
      '-f',
      `expected_head_sha=${action.headSha}`
    ],
    signal,
    () => tracker.markDispatched()
  )
  for (let attempt = 0; attempt < 20; attempt++) {
    const review = JSON.parse(
      await runGitHubApi(
        state.ownerRepo,
        state.ghOptions,
        'core',
        [
          'api',
          `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/pulls/${definition.reviewNumber}`
        ],
        signal
      )
    ) as { head?: { sha?: unknown } }
    const updatedHead = stringValue(review.head?.sha)
    if (updatedHead && updatedHead !== action.headSha) {
      const commit = JSON.parse(
        await runGitHubApi(
          state.ownerRepo,
          state.ghOptions,
          'core',
          [
            'api',
            `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/git/commits/${updatedHead}`
          ],
          signal
        )
      ) as { parents?: { sha?: unknown }[] }
      const parents = commit.parents?.map((parent) => stringValue(parent.sha)) ?? []
      if (parents.length !== 2 || parents[0] !== action.headSha || parents[1] !== action.baseSha) {
        throw new Error('GitHub branch head changed to an unattributable commit after update.')
      }
      return { kind: 'published', resultingHeadSha: updatedHead }
    }
    await waitForUpdatePoll(signal)
  }
  throw new Error('GitHub accepted the branch update but its resulting head is not yet verifiable.')
}

async function mergeOrEnqueue(
  definition: HostedReviewSitterDefinition,
  state: GitHubState,
  action: Extract<ProviderAction, { kind: 'merge' | 'enqueue' }>,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  assertMergeGates(state.snapshot, action.headSha)
  throwIfAborted(signal)
  if (action.kind === 'merge') {
    if (state.snapshot.queue.required) {
      throw new Error('GitHub requires this pull request to use the merge queue.')
    }
    const response = JSON.parse(
      await runGitHubApi(
        state.ownerRepo,
        state.ghOptions,
        'core',
        [
          'api',
          '-X',
          'PUT',
          `repos/${state.ownerRepo.owner}/${state.ownerRepo.repo}/pulls/${definition.reviewNumber}/merge`,
          '-f',
          `sha=${action.headSha}`,
          '-f',
          `merge_method=${action.mergeMethod}`
        ],
        signal,
        () => tracker.markDispatched()
      )
    ) as { merged?: unknown; message?: unknown }
    if (response.merged !== true) {
      throw new Error(
        stringValue(response.message) || 'GitHub did not confirm that the pull request merged.'
      )
    }
    return { kind: 'none' }
  }
  if (!state.snapshot.queue.required || state.snapshot.queue.membership === 'enqueued') {
    throw new Error('GitHub merge queue state no longer permits enqueue.')
  }
  await assertQueueMergeMethod(definition, state, signal)
  if (!state.pullRequestId) {
    throw new Error('GitHub did not return a pull request node identity for enqueue.')
  }
  throwIfAborted(signal)
  const response = JSON.parse(
    await runGitHubApi(
      state.ownerRepo,
      state.ghOptions,
      'graphql',
      [
        'api',
        'graphql',
        '-f',
        `query=${ENQUEUE_PULL_REQUEST_MUTATION}`,
        '-f',
        `pullRequestId=${state.pullRequestId}`,
        '-f',
        `expectedHeadOid=${action.headSha}`
      ],
      signal,
      () => tracker.markDispatched()
    )
  ) as {
    data?: { enqueuePullRequest?: { mergeQueueEntry?: { state?: unknown } | null } | null }
    errors?: unknown[]
  }
  const queuedState = stringValue(
    response.data?.enqueuePullRequest?.mergeQueueEntry?.state
  ).toUpperCase()
  if (
    response.errors?.length ||
    !['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'].includes(queuedState)
  ) {
    throw new Error('GitHub did not confirm merge queue enrollment.')
  }
  return { kind: 'none' }
}

export async function executeGitHubSitterAction(
  definition: HostedReviewSitterDefinition,
  action: ProviderAction,
  git: HostedReviewSitterGitExecution,
  signal: AbortSignal | undefined,
  tracker: HostedReviewSitterMutationTracker
): Promise<HostedReviewSitterActionResult> {
  const state = await loadGitHubState(definition, git, true, signal)
  throwIfAborted(signal)
  if (!state.sourceIdentityComplete) {
    throw new Error('The GitHub pull request source repository or branch is no longer verifiable.')
  }
  switch (action.kind) {
    case 'rerun-check':
      return rerunChecks(state, action, signal, tracker)
    case 'update-branch':
      return updateBranch(definition, git, state, action, signal, tracker)
    case 'merge':
    case 'enqueue':
      return mergeOrEnqueue(definition, state, action, signal, tracker)
  }
}
