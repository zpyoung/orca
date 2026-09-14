import type { GitHubApiRepository } from '../github/github-api-repository'
import { getPRCheckDetails } from '../github/client'
import type {
  HostedReviewCheckSnapshot,
  HostedReviewProviderReadiness,
  HostedReviewSnapshot,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import {
  deriveHostedReviewCheckIdentity,
  githubCheckState,
  githubStatusContextState,
  stableFailureSignature
} from './provider-check-normalization'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import type {
  GitHubCheckNode,
  GitHubPullRequestState,
  RequiredStatus
} from './provider-github-read'

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function checkNodeName(node: GitHubCheckNode): string {
  return node.__typename === 'StatusContext' ? stringValue(node.context) : stringValue(node.name)
}

function checkNodeAppId(node: GitHubCheckNode): number | null {
  const suite = node.checkSuite && typeof node.checkSuite === 'object' ? node.checkSuite : null
  const app =
    suite && 'app' in suite && suite.app && typeof suite.app === 'object' ? suite.app : null
  return app && 'databaseId' in app ? numberValue(app.databaseId) : null
}

function requiredStatusMatches(node: GitHubCheckNode, required: RequiredStatus): boolean {
  return (
    checkNodeName(node) === required.context &&
    (required.integrationId === null || checkNodeAppId(node) === required.integrationId)
  )
}

function checkNodeId(node: GitHubCheckNode): string {
  if (node.__typename === 'StatusContext') {
    return `status:${stringValue(node.id) || checkNodeName(node)}`
  }
  const suite = node.checkSuite && typeof node.checkSuite === 'object' ? node.checkSuite : null
  const workflow =
    suite && 'workflowRun' in suite && suite.workflowRun && typeof suite.workflowRun === 'object'
      ? suite.workflowRun
      : null
  const workflowId = workflow && 'databaseId' in workflow ? numberValue(workflow.databaseId) : null
  const checkId = numberValue(node.databaseId)
  return workflowId
    ? `workflow:${workflowId}:check:${checkId ?? 'unknown'}`
    : `check:${checkId ?? 'unknown'}`
}

function checkObservationId(node: GitHubCheckNode, headSha: string): string {
  const stamp =
    node.__typename === 'StatusContext'
      ? stringValue(node.createdAt)
      : `${stringValue(node.startedAt)}:${stringValue(node.completedAt)}`
  return `${headSha}:${checkNodeId(node)}:${stamp}`
}

function checkNodeSortKey(node: GitHubCheckNode): string {
  const timestamp =
    node.__typename === 'StatusContext'
      ? stringValue(node.createdAt)
      : stringValue(node.completedAt) || stringValue(node.startedAt)
  return `${timestamp}\0${numberValue(node.databaseId) ?? 0}\0${stringValue(node.id)}`
}

export function normalizeChecks(
  nodes: GitHubCheckNode[],
  requiredStatuses: RequiredStatus[],
  headSha: string
): { checks: HostedReviewCheckSnapshot[]; identityComplete: boolean } {
  const latest = new Map<string, { snapshot: HostedReviewCheckSnapshot; sortKey: string }>()
  let identityComplete = true
  for (const node of nodes) {
    const name = checkNodeName(node)
    if (!name) {
      identityComplete = false
      continue
    }
    const matchingRequired = requiredStatuses.filter((required) =>
      requiredStatusMatches(node, required)
    )
    const appId = checkNodeAppId(node)
    if (
      requiredStatuses.some(
        (required) => required.context === name && required.integrationId !== null && appId === null
      )
    ) {
      identityComplete = false
    }
    const identity = deriveHostedReviewCheckIdentity(name)
    const checkId = checkNodeId(node)
    const state =
      node.__typename === 'StatusContext'
        ? githubStatusContextState(node.state)
        : githubCheckState(node.status, node.conclusion)
    const snapshot: HostedReviewCheckSnapshot = {
      ...identity,
      checkId,
      name,
      required: node.isRequired === true || matchingRequired.length > 0,
      headSha,
      state,
      observationId: checkObservationId(node, headSha),
      failureSignature:
        node.__typename === 'StatusContext' && state === 'failed'
          ? stableFailureSignature(identity.checkKey, [stringValue(node.description)])
          : null
    }
    const key = `${identity.checkKey}\0${identity.shardKey ?? ''}\0${identity.runtimeKey ?? ''}\0${node.__typename ?? 'unknown'}\0${appId ?? 'unknown-app'}`
    const sortKey = checkNodeSortKey(node)
    if (!latest.has(key) || latest.get(key)!.sortKey <= sortKey) {
      latest.set(key, { snapshot, sortKey })
    }
  }
  const checks = [...latest.values()].map(({ snapshot }) => snapshot)
  for (const required of requiredStatuses) {
    if (nodes.some((node) => requiredStatusMatches(node, required))) {
      continue
    }
    const identity = deriveHostedReviewCheckIdentity(required.context)
    checks.push({
      ...identity,
      checkId: `missing:${required.integrationId ?? 'any'}:${required.context}`,
      name: required.context,
      required: true,
      headSha,
      state: 'unknown',
      observationId: `${headSha}:missing:${required.integrationId ?? 'any'}:${required.context}`,
      failureSignature: null
    })
  }
  return { checks, identityComplete }
}

export async function attachGitHubFailureSignatures(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  ownerRepo: GitHubApiRepository,
  checks: HostedReviewCheckSnapshot[],
  signal?: AbortSignal
): Promise<boolean> {
  let complete = true
  throwIfAborted(signal)
  for (const check of checks) {
    if (!check.required || check.state !== 'failed' || check.failureSignature) {
      continue
    }
    const workflow = check.checkId.match(/^workflow:(\d+):check:(\d+|unknown)$/)
    const direct = check.checkId.match(/^check:(\d+)$/)
    if (!workflow && !direct) {
      complete = false
      continue
    }
    try {
      const details = await getPRCheckDetails(
        definition.repoPath,
        {
          ...(workflow ? { workflowRunId: Number(workflow[1]) } : {}),
          ...(direct ? { checkRunId: Number(direct[1]) } : {}),
          checkName: check.name,
          prRepo: ownerRepo
        },
        git.connectionId,
        git.localGitOptions
      )
      throwIfAborted(signal)
      if (!details) {
        complete = false
        continue
      }
      const evidence = [
        details.title ?? '',
        details.summary ?? '',
        details.text ?? '',
        ...details.annotations.map((item) => `${item.title ?? ''}\n${item.message}`),
        ...details.jobs.flatMap((job) => [
          job.name,
          ...job.steps
            .filter((step) => ['failure', 'failed', 'timed_out'].includes(step.conclusion ?? ''))
            .map((step) => step.name),
          job.logTail ?? ''
        ])
      ]
      check.failureSignature = stableFailureSignature(check.checkKey, evidence)
      if (!check.failureSignature) {
        complete = false
      }
    } catch {
      throwIfAborted(signal)
      complete = false
    }
  }
  return complete
}

export function queueSnapshot(
  pr: GitHubPullRequestState,
  policy: { complete: boolean; mergeQueueRequired: boolean }
): { queue: HostedReviewSnapshot['queue']; known: boolean } {
  if (!policy.complete || typeof pr.isMergeQueueEnabled !== 'boolean') {
    return { queue: { required: false, membership: 'unknown' }, known: false }
  }
  if (pr.isMergeQueueEnabled !== policy.mergeQueueRequired) {
    return { queue: { required: policy.mergeQueueRequired, membership: 'unknown' }, known: false }
  }
  if (!policy.mergeQueueRequired) {
    return { queue: { required: false, membership: 'not-enqueued' }, known: true }
  }
  const state = stringValue(pr.mergeQueueEntry?.state).toUpperCase()
  if (state === 'UNMERGEABLE') {
    return { queue: { required: true, membership: 'ejected' }, known: true }
  }
  if (['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED'].includes(state)) {
    return { queue: { required: true, membership: 'enqueued' }, known: true }
  }
  if (pr.isInMergeQueue === false && pr.mergeQueueEntry == null) {
    return { queue: { required: true, membership: 'not-enqueued' }, known: true }
  }
  return { queue: { required: true, membership: 'unknown' }, known: false }
}

export function githubReadiness(
  pr: GitHubPullRequestState,
  checks: readonly HostedReviewCheckSnapshot[],
  evidenceComplete: boolean,
  conflicts: HostedReviewSnapshot['conflicts']
): HostedReviewProviderReadiness {
  if (!evidenceComplete || conflicts === 'unknown') {
    return { verdict: 'unknown', blockers: ['unknown'] }
  }
  const mergeState = stringValue(pr.mergeStateStatus).toUpperCase()
  if (mergeState === 'DIRTY' || conflicts === 'present') {
    return { verdict: 'blocked', blockers: ['conflicts'] }
  }
  if (mergeState === 'CLEAN' || mergeState === 'UNSTABLE') {
    return { verdict: 'ready', blockers: [] }
  }
  if (mergeState === 'BEHIND') {
    return { verdict: 'blocked', blockers: ['behind'] }
  }
  if (mergeState === 'DRAFT' || pr.isDraft === true) {
    return { verdict: 'blocked', blockers: ['draft'] }
  }
  if (mergeState !== 'BLOCKED') {
    return { verdict: 'unknown', blockers: ['unknown'] }
  }
  const blockers: HostedReviewProviderReadiness['blockers'][number][] = []
  if (checks.some((check) => check.required && check.state !== 'passed')) {
    blockers.push('checks')
  }
  if (
    ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(stringValue(pr.reviewDecision).toUpperCase())
  ) {
    blockers.push('approvals')
  }
  if (blockers.length === 0) {
    blockers.push('policy')
  }
  return { verdict: 'blocked', blockers }
}
