import type { HostedReviewInfo } from '../../shared/hosted-review'
import type {
  HostedReviewMergeMethod,
  HostedReviewSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import type { GitHubApiRepository, GitHubRepoExecOptions } from '../github/github-api-repository'
import { githubHostExecOptions, resolveGitHubRepoExecution } from '../github/github-api-repository'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { assertRateLimitBudget } from '../github/client/lookup/pr-lookup-rate-limit'
import { acquire, extractExecError, ghExecFileAsync, release } from '../github/gh-utils'
import { noteRepositoryRateLimitSpend } from '../github/rate-limit'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import { gitHubRepositoryFromReviewUrl } from './provider-push-target'
import {
  attachGitHubFailureSignatures,
  githubReadiness,
  normalizeChecks,
  queueSnapshot
} from './provider-github-checks'

const GITHUB_SITTER_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    viewerDefaultMergeMethod
    mergeCommitAllowed
    rebaseMergeAllowed
    squashMergeAllowed
    pullRequest(number: $pr) {
      id
      url
      state
      merged
      isDraft
      headRefOid
      headRefName
      headRepository { nameWithOwner }
      baseRefOid
      baseRefName
      mergeable
      mergeStateStatus
      reviewDecision
      isInMergeQueue
      isMergeQueueEnabled
      mergeQueueEntry { id state }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    databaseId
                    name
                    status
                    conclusion
                    detailsUrl
                    startedAt
                    completedAt
                    isRequired(pullRequestNumber: $pr)
                    checkSuite {
                      databaseId
                      app { databaseId }
                      workflowRun { databaseId }
                    }
                  }
                  ... on StatusContext {
                    id
                    context
                    state
                    description
                    createdAt
                    targetUrl
                    isRequired(pullRequestNumber: $pr)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

export const ENQUEUE_PULL_REQUEST_MUTATION = `
mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid}) {
    mergeQueueEntry { id state }
  }
}`

export type RequiredStatus = { context: string; integrationId: number | null }
export type GitHubCheckNode = Record<string, unknown> & { __typename?: string }
export type GitHubPullRequestState = {
  id?: unknown
  url?: unknown
  state?: unknown
  merged?: unknown
  isDraft?: unknown
  headRefOid?: unknown
  headRefName?: unknown
  headRepository?: { nameWithOwner?: unknown } | null
  baseRefOid?: unknown
  baseRefName?: unknown
  mergeable?: unknown
  mergeStateStatus?: unknown
  reviewDecision?: unknown
  isInMergeQueue?: unknown
  isMergeQueueEnabled?: unknown
  mergeQueueEntry?: { state?: unknown } | null
  commits?: {
    nodes?:
      | ({
          commit?: {
            oid?: unknown
            statusCheckRollup?: {
              contexts?: {
                pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }
                nodes?: GitHubCheckNode[] | null
              } | null
            } | null
          } | null
        } | null)[]
      | null
  } | null
}
type GitHubRepositoryState = {
  viewerDefaultMergeMethod?: unknown
  mergeCommitAllowed?: unknown
  rebaseMergeAllowed?: unknown
  squashMergeAllowed?: unknown
  pullRequest?: GitHubPullRequestState | null
}
export type GitHubState = {
  snapshot: HostedReviewSnapshot
  ownerRepo: GitHubApiRepository
  ghOptions: GitHubRepoExecOptions
  pullRequestId: string
  baseRefName: string
  sourceIdentityComplete: boolean
}

export type ProviderAction = Extract<
  HostedReviewSitterAction,
  { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
>

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function runGitHubApi(
  ownerRepo: GitHubApiRepository,
  ghOptions: GitHubRepoExecOptions,
  bucket: 'core' | 'graphql',
  args: string[],
  signal?: AbortSignal,
  onDispatch?: () => void
): Promise<string> {
  await assertRateLimitBudget(bucket, ownerRepo, ghOptions)
  throwIfAborted(signal)
  await acquire()
  try {
    throwIfAborted(signal)
    onDispatch?.()
    const { stdout } = await ghExecFileAsync(args, {
      ...ghOptions,
      ...githubHostExecOptions(ownerRepo),
      ...(signal ? { signal } : {})
    })
    noteRepositoryRateLimitSpend(ownerRepo, bucket, 1, ghOptions)
    return stdout
  } finally {
    release()
  }
}

function lifecycleForPullRequest(pr: GitHubPullRequestState): HostedReviewSnapshot['lifecycle'] {
  if (pr.merged === true) {
    return 'merged'
  }
  return stringValue(pr.state).toUpperCase() === 'OPEN' ? 'open' : 'closed'
}

function defaultMergeMethod(repository: GitHubRepositoryState): {
  method: HostedReviewMergeMethod
  known: boolean
} {
  switch (stringValue(repository.viewerDefaultMergeMethod).toUpperCase()) {
    case 'MERGE':
      return { method: 'merge', known: repository.mergeCommitAllowed === true }
    case 'REBASE':
      return { method: 'rebase', known: repository.rebaseMergeAllowed === true }
    case 'SQUASH':
      return { method: 'squash', known: repository.squashMergeAllowed === true }
    default:
      return { method: 'squash', known: false }
  }
}

function isNotFound(error: unknown): boolean {
  const { stderr } = extractExecError(error)
  return /(?:HTTP\s+404|not found)/i.test(stderr || (error instanceof Error ? error.message : ''))
}

function requiredStatusesFromRules(value: unknown): {
  complete: boolean
  statuses: RequiredStatus[]
  mergeQueueRequired: boolean
} {
  if (!Array.isArray(value)) {
    return { complete: false, statuses: [], mergeQueueRequired: false }
  }
  const statuses: RequiredStatus[] = []
  let mergeQueueRequired = false
  for (const rawRule of value) {
    if (!rawRule || typeof rawRule !== 'object') {
      return { complete: false, statuses: [], mergeQueueRequired: false }
    }
    const rule = rawRule as Record<string, unknown>
    if (rule.type === 'merge_queue') {
      mergeQueueRequired = true
    }
    if (rule.type !== 'required_status_checks') {
      continue
    }
    const parameters =
      rule.parameters && typeof rule.parameters === 'object'
        ? (rule.parameters as Record<string, unknown>)
        : null
    const required = parameters?.required_status_checks
    if (!Array.isArray(required)) {
      return { complete: false, statuses: [], mergeQueueRequired }
    }
    for (const rawStatus of required) {
      if (!rawStatus || typeof rawStatus !== 'object') {
        return { complete: false, statuses: [], mergeQueueRequired }
      }
      const status = rawStatus as Record<string, unknown>
      const context = stringValue(status.context)
      if (!context) {
        return { complete: false, statuses: [], mergeQueueRequired }
      }
      const rawIntegrationId = status.integration_id ?? status.app_id
      const integrationId = numberValue(rawIntegrationId)
      if (rawIntegrationId !== undefined && integrationId === null) {
        return { complete: false, statuses: [], mergeQueueRequired }
      }
      statuses.push({ context, integrationId })
    }
  }
  return { complete: true, statuses, mergeQueueRequired }
}

async function loadRequiredStatuses(
  ownerRepo: GitHubApiRepository,
  ghOptions: GitHubRepoExecOptions,
  branch: string,
  signal?: AbortSignal
): Promise<{ complete: boolean; statuses: RequiredStatus[]; mergeQueueRequired: boolean }> {
  const endpoint = `repos/${ownerRepo.owner}/${ownerRepo.repo}/rules/branches/${encodeURIComponent(branch)}`
  try {
    const stdout = await runGitHubApi(
      ownerRepo,
      ghOptions,
      'core',
      ['api', '--method', 'GET', endpoint, '-f', 'per_page=100', '--paginate', '--slurp'],
      signal
    )
    const parsed = JSON.parse(stdout) as unknown
    const rules =
      Array.isArray(parsed) && parsed.every((page) => Array.isArray(page)) ? parsed.flat() : parsed
    return requiredStatusesFromRules(rules)
  } catch (error) {
    throwIfAborted(signal)
    if (isNotFound(error)) {
      return { complete: false, statuses: [], mergeQueueRequired: false }
    }
    return { complete: false, statuses: [], mergeQueueRequired: false }
  }
}

async function loadGitHubPages(
  ownerRepo: GitHubApiRepository,
  ghOptions: GitHubRepoExecOptions,
  reviewNumber: number,
  fresh: boolean,
  signal?: AbortSignal
): Promise<{ repository: GitHubRepositoryState; checks: GitHubCheckNode[]; complete: boolean }> {
  let after: string | null = null
  let repository: GitHubRepositoryState | null = null
  let expectedHead = ''
  const checks: GitHubCheckNode[] = []
  for (let page = 0; page < 100; page++) {
    const cacheArgs = fresh ? [] : ['--cache', '60s']
    const args = [
      'api',
      'graphql',
      ...cacheArgs,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`,
      '-F',
      `pr=${reviewNumber}`,
      '-f',
      `query=${GITHUB_SITTER_QUERY}`
    ]
    if (after) {
      args.push('-f', `after=${after}`)
    }
    const parsed = JSON.parse(
      await runGitHubApi(ownerRepo, ghOptions, 'graphql', args, signal)
    ) as {
      data?: { repository?: GitHubRepositoryState | null }
      errors?: unknown[]
    }
    if (parsed.errors?.length || !parsed.data?.repository?.pullRequest) {
      throw new Error('GitHub returned incomplete hosted review data.')
    }
    const pageRepository = parsed.data.repository
    const pullRequest = pageRepository.pullRequest!
    const commit = pullRequest.commits?.nodes?.[0]?.commit
    const head = stringValue(pullRequest.headRefOid)
    if (!head || stringValue(commit?.oid) !== head || (expectedHead && expectedHead !== head)) {
      return { repository: pageRepository, checks, complete: false }
    }
    expectedHead = head
    repository ??= pageRepository
    const contexts = commit?.statusCheckRollup?.contexts
    if (!contexts) {
      return { repository, checks, complete: true }
    }
    if (!Array.isArray(contexts.nodes)) {
      return { repository, checks, complete: false }
    }
    checks.push(...contexts.nodes)
    if (contexts.pageInfo?.hasNextPage !== true) {
      return { repository, checks, complete: true }
    }
    after = stringValue(contexts.pageInfo.endCursor)
    if (!after) {
      return { repository, checks, complete: false }
    }
  }
  if (!repository) {
    throw new Error('GitHub returned no hosted review data.')
  }
  return { repository, checks, complete: false }
}

export async function loadGitHubState(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  fresh: boolean,
  signal?: AbortSignal
): Promise<GitHubState> {
  let cachedReview: HostedReviewInfo | null = null
  if (!fresh) {
    cachedReview = await getHostedReviewForBranch({
      repoPath: definition.repoPath,
      executionHostId: git.executionHostId,
      branch: definition.branch,
      linkedGitHubPR: definition.reviewNumber,
      active: true,
      localGitExecOptions: git.localGitOptions
    })
    throwIfAborted(signal)
    if (
      !cachedReview ||
      cachedReview.provider !== 'github' ||
      cachedReview.number !== definition.reviewNumber
    ) {
      throw new Error('The armed GitHub pull request could not be found.')
    }
  }
  const reviewRepository =
    gitHubRepositoryFromReviewUrl(definition.reviewUrl, definition.reviewNumber) ??
    cachedReview?.githubRepository
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    definition.repoPath,
    reviewRepository,
    git.connectionId,
    git.localGitOptions
  )
  if (!ownerRepo) {
    throw new Error('Could not resolve the GitHub host and repository for this sitter.')
  }
  const pages = await loadGitHubPages(ownerRepo, ghOptions, definition.reviewNumber, fresh, signal)
  const pr = pages.repository.pullRequest!
  const headSha = stringValue(pr.headRefOid)
  const baseSha = stringValue(pr.baseRefOid)
  const baseRefName = stringValue(pr.baseRefName)
  const reviewPushTarget = fresh ? await git.reviewPushTarget(signal) : null
  const sourceIdentityComplete =
    stringValue(pr.headRefName) === definition.branch &&
    Boolean(stringValue(pr.headRepository?.nameWithOwner)) &&
    (!fresh || reviewPushTarget?.branchName === definition.branch)
  const policy = baseRefName
    ? await loadRequiredStatuses(ownerRepo, ghOptions, baseRefName, signal)
    : { complete: false, statuses: [], mergeQueueRequired: false }
  const normalized = normalizeChecks(pages.checks, policy.statuses, headSha)
  const detailsComplete = await attachGitHubFailureSignatures(
    definition,
    git,
    ownerRepo,
    normalized.checks,
    signal
  )
  const queue = queueSnapshot(pr, policy)
  const mergeMethod = defaultMergeMethod(pages.repository)
  let conflicts: HostedReviewSnapshot['conflicts'] =
    stringValue(pr.mergeable).toUpperCase() === 'CONFLICTING'
      ? 'present'
      : stringValue(pr.mergeable).toUpperCase() === 'MERGEABLE'
        ? 'none'
        : 'unknown'
  if (conflicts === 'unknown' && headSha && baseSha) {
    conflicts = await git.simulateConflicts(headSha, baseSha, signal)
  }
  const checksComplete =
    pages.complete &&
    policy.complete &&
    normalized.identityComplete &&
    detailsComplete &&
    Boolean(headSha)
  const evidenceComplete =
    checksComplete &&
    sourceIdentityComplete &&
    queue.known &&
    mergeMethod.known &&
    Boolean(baseSha && baseRefName)
  const snapshot: HostedReviewSnapshot = {
    provider: 'github',
    reviewNumber: definition.reviewNumber,
    url: stringValue(pr.url) || cachedReview?.url || definition.reviewUrl,
    lifecycle: lifecycleForPullRequest(pr),
    headSha,
    baseSha,
    observedAtMs: Date.now(),
    freshness: fresh ? 'live' : 'cached',
    draft: pr.isDraft === true,
    checks: normalized.checks,
    checksComplete,
    providerReadiness: githubReadiness(pr, normalized.checks, evidenceComplete, conflicts),
    behindBase: stringValue(pr.mergeStateStatus).toUpperCase() === 'BEHIND',
    conflicts,
    queue: queue.queue,
    defaultMergeMethod: mergeMethod.method
  }
  return {
    snapshot,
    ownerRepo,
    ghOptions,
    pullRequestId: stringValue(pr.id),
    sourceIdentityComplete,
    baseRefName
  }
}

export async function readGitHubSitterSnapshot(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  options: { fresh: boolean }
): Promise<HostedReviewSnapshot> {
  return (await loadGitHubState(definition, git, options.fresh)).snapshot
}
