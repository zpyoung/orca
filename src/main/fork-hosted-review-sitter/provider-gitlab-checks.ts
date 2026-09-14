import type {
  HostedReviewCheckSnapshot,
  HostedReviewMergeMethod,
  HostedReviewProviderReadiness,
  HostedReviewSnapshot,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import type { ProjectRef } from '../gitlab/gl-utils'
import { encodedProject } from '../gitlab/project-path-encoding'
import {
  deriveHostedReviewCheckIdentity,
  gitlabJobState,
  stableFailureSignature
} from './provider-check-normalization'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import {
  booleanValue,
  isNotFound,
  numberValue,
  runGitLabApi,
  stringValue,
  type GitLabJob,
  type GitLabMergeRequest,
  type GitLabPipeline,
  type GitLabProject
} from './provider-gitlab-read'

type QueueEvidence = {
  queue: HostedReviewSnapshot['queue']
  known: boolean
}

export async function loadBaseSha(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  branch: string,
  signal?: AbortSignal
): Promise<string> {
  const value = JSON.parse(
    await runGitLabApi(
      definition,
      git,
      projectRef,
      [
        `projects/${encodedProject(projectRef.path)}/repository/branches/${encodeURIComponent(branch)}`
      ],
      { signal }
    )
  ) as { commit?: { id?: unknown } }
  return stringValue(value.commit?.id)
}

export function pipelineFromMergeRequest(mergeRequest: GitLabMergeRequest): GitLabPipeline | null {
  return mergeRequest.head_pipeline ?? mergeRequest.pipeline ?? null
}

async function loadPipelinePage(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  projectKey: string,
  pipelineId: number,
  kind: 'jobs' | 'bridges',
  page: number,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const query = `per_page=100&page=${page}${kind === 'jobs' ? '&include_retried=true' : ''}`
  const value = JSON.parse(
    await runGitLabApi(
      definition,
      git,
      projectRef,
      [`projects/${projectKey}/pipelines/${pipelineId}/${kind}?${query}`],
      { signal }
    )
  )
  if (!Array.isArray(value)) {
    throw new Error(`GitLab returned invalid pipeline ${kind} data.`)
  }
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object')
  )
}

export async function loadAllPipelineRows(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  pipeline: GitLabPipeline,
  signal?: AbortSignal
): Promise<{ jobs: GitLabJob[]; complete: boolean }> {
  const pipelineId = numberValue(pipeline.id)
  if (!pipelineId) {
    return { jobs: [], complete: false }
  }
  const queue: {
    projectKey: string
    pipelineId: number
    sha: string
    logicalPath: string
  }[] = [
    {
      projectKey: encodedProject(projectRef.path),
      pipelineId,
      sha: stringValue(pipeline.sha),
      logicalPath: projectRef.path
    }
  ]
  const seen = new Set<string>()
  const jobs: GitLabJob[] = []
  let complete = true
  for (let pipelineIndex = 0; pipelineIndex < queue.length; pipelineIndex++) {
    if (pipelineIndex >= 21) {
      complete = false
      break
    }
    const target = queue[pipelineIndex]!
    const targetKey = `${target.projectKey}:${target.pipelineId}`
    if (seen.has(targetKey)) {
      continue
    }
    seen.add(targetKey)
    for (const kind of ['jobs', 'bridges'] as const) {
      for (let page = 1; page <= 100; page++) {
        const rows = await loadPipelinePage(
          definition,
          git,
          projectRef,
          target.projectKey,
          target.pipelineId,
          kind,
          page,
          signal
        )
        if (kind === 'jobs') {
          for (const row of rows) {
            jobs.push({
              ...row,
              sitter_pipeline_path: target.logicalPath,
              sitter_project_key: target.projectKey,
              pipeline:
                row.pipeline && typeof row.pipeline === 'object'
                  ? (row.pipeline as GitLabPipeline)
                  : { id: target.pipelineId, sha: target.sha }
            })
          }
        } else {
          for (const row of rows) {
            const downstream =
              row.downstream_pipeline && typeof row.downstream_pipeline === 'object'
                ? (row.downstream_pipeline as GitLabPipeline)
                : null
            const childId = numberValue(downstream?.id)
            if (!childId) {
              continue
            }
            const childProjectId = numberValue(downstream?.project_id)
            if (queue.length >= 21) {
              complete = false
              continue
            }
            queue.push({
              projectKey: childProjectId ? String(childProjectId) : target.projectKey,
              pipelineId: childId,
              sha: stringValue(downstream?.sha) || target.sha,
              logicalPath: `${target.logicalPath}/${stringValue(row.name) || 'bridge'}`
            })
          }
        }
        if (rows.length < 100) {
          break
        }
        if (page === 100) {
          complete = false
        }
      }
    }
  }
  return { jobs, complete }
}

export function normalizePipelineJobs(
  jobs: GitLabJob[],
  fallbackHeadSha: string,
  pipelineRequired: boolean,
  allowSkippedPipeline: boolean
): { checks: HostedReviewCheckSnapshot[]; complete: boolean } {
  const latestByJob = new Map<string, GitLabJob>()
  let complete = true
  for (const job of jobs) {
    const name = stringValue(job.name)
    const stage = stringValue(job.stage)
    const id = numberValue(job.id)
    const pipelinePath = stringValue(job.sitter_pipeline_path)
    const projectKey = stringValue(job.sitter_project_key)
    const pipelineId = numberValue(job.pipeline?.id)
    if (!name || !id || !pipelinePath || !projectKey || !pipelineId) {
      complete = false
      continue
    }
    const key = `${pipelinePath}\0${pipelineId}\0${stage}\0${name}`
    const prior = latestByJob.get(key)
    if (!prior || (numberValue(prior.id) ?? 0) < id) {
      latestByJob.set(key, job)
    }
  }
  const checks = [...latestByJob.values()].map((job): HostedReviewCheckSnapshot => {
    const name = stringValue(job.name)
    const stage = stringValue(job.stage)
    const pipelinePath = stringValue(job.sitter_pipeline_path)
    const projectKey = stringValue(job.sitter_project_key)
    const identity = deriveHostedReviewCheckIdentity(name)
    const id = numberValue(job.id)!
    const pipelineSha = stringValue(job.pipeline?.sha) || fallbackHeadSha
    const allowFailure = booleanValue(job.allow_failure)
    const required = pipelineRequired && allowFailure !== true
    if (pipelineRequired && allowFailure === null) {
      complete = false
    }
    if (required && !stringValue(job.pipeline?.sha)) {
      complete = false
    }
    const rawState = gitlabJobState(job.status)
    const state = rawState === 'skipped' && allowSkippedPipeline ? 'passed' : rawState
    return {
      ...identity,
      checkKey: [pipelinePath, stage, identity.checkKey].filter(Boolean).join('/'),
      checkId: `job:${encodeURIComponent(projectKey)}:${id}`,
      name,
      required,
      headSha: pipelineSha,
      state,
      observationId: `${pipelineSha}:job:${id}:${stringValue(job.started_at)}:${stringValue(job.finished_at)}`,
      failureSignature: null
    }
  })
  return { checks, complete }
}

export async function loadExternalStatusChecks(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  headSha: string,
  required: boolean,
  signal?: AbortSignal
): Promise<{ checks: HostedReviewCheckSnapshot[]; complete: boolean }> {
  if (!required) {
    return { checks: [], complete: true }
  }
  try {
    const rows: unknown[] = []
    for (let page = 1; page <= 100; page++) {
      const value = JSON.parse(
        await runGitLabApi(
          definition,
          git,
          projectRef,
          [
            `projects/${encodedProject(projectRef.path)}/merge_requests/${definition.reviewNumber}/status_checks?per_page=100&page=${page}`
          ],
          { signal }
        )
      )
      if (!Array.isArray(value)) {
        return { checks: [], complete: false }
      }
      rows.push(...value)
      if (value.length < 100) {
        break
      }
      if (page === 100) {
        return { checks: [], complete: false }
      }
    }
    if (rows.length === 0) {
      return { checks: [], complete: false }
    }
    const checks: HostedReviewCheckSnapshot[] = []
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') {
        return { checks, complete: false }
      }
      const status = raw as Record<string, unknown>
      const name = stringValue(status.name)
      const id = numberValue(status.id)
      if (!name || !id) {
        return { checks, complete: false }
      }
      const state = gitlabJobState(status.status)
      const identity = deriveHostedReviewCheckIdentity(name)
      checks.push({
        ...identity,
        checkId: `status-check:${id}`,
        name,
        required: true,
        headSha,
        state,
        observationId: `${headSha}:status-check:${id}:${stringValue(status.status)}`,
        failureSignature:
          state === 'failed'
            ? stableFailureSignature(identity.checkKey, [name, stringValue(status.status)])
            : null
      })
    }
    return { checks, complete: true }
  } catch {
    throwIfAborted(signal)
    return { checks: [], complete: false }
  }
}

export async function attachGitLabFailureSignatures(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  checks: HostedReviewCheckSnapshot[],
  signal?: AbortSignal
): Promise<boolean> {
  let complete = true
  for (const check of checks) {
    if (!check.required || check.state !== 'failed' || check.failureSignature) {
      continue
    }
    const match = check.checkId.match(/^job:([^:]+):(\d+)$/)
    if (!match) {
      complete = false
      continue
    }
    try {
      const trace = await runGitLabApi(
        definition,
        git,
        projectRef,
        [`projects/${match[1]}/jobs/${match[2]}/trace`],
        { signal }
      )
      check.failureSignature = stableFailureSignature(check.checkKey, [trace])
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

export function defaultMergeMethod(project: GitLabProject): {
  method: HostedReviewMergeMethod
  known: boolean
} {
  const squash = stringValue(project.squash_option).toLowerCase()
  if (squash === 'always' || squash === 'default_on') {
    return { method: 'squash', known: true }
  }
  const mergeMethod = stringValue(project.merge_method).toLowerCase()
  if (mergeMethod === 'merge') {
    return { method: 'merge', known: Boolean(squash) }
  }
  if (mergeMethod === 'rebase_merge' || mergeMethod === 'ff') {
    return { method: 'rebase', known: Boolean(squash) }
  }
  return { method: 'merge', known: false }
}

function queueRequirement(project: GitLabProject): { required: boolean; known: boolean } {
  const enabled = booleanValue(project.merge_trains_enabled)
  const enforcement = stringValue(project.merge_train_enforcement).toLowerCase()
  if (
    enabled === true &&
    ['always', 'required', 'enforce_for_all_users', 'enforce_with_owner_override'].includes(
      enforcement
    )
  ) {
    return { required: true, known: true }
  }
  if (
    enabled === false ||
    ['disabled', 'none', 'allow_bypass'].includes(enforcement) ||
    (enabled === true && !enforcement)
  ) {
    return { required: false, known: true }
  }
  return { required: false, known: false }
}

export async function loadQueueEvidence(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  project: GitLabProject,
  signal?: AbortSignal
): Promise<QueueEvidence> {
  const requirement = queueRequirement(project)
  if (!requirement.known) {
    return { queue: { required: false, membership: 'unknown' }, known: false }
  }
  if (!requirement.required) {
    return { queue: { required: false, membership: 'not-enqueued' }, known: true }
  }
  try {
    const value = JSON.parse(
      await runGitLabApi(
        definition,
        git,
        projectRef,
        [
          `projects/${encodedProject(projectRef.path)}/merge_trains/merge_requests/${definition.reviewNumber}`
        ],
        { signal }
      )
    ) as Record<string, unknown>
    const status = stringValue(value.status).toLowerCase()
    if (status === 'stale') {
      return { queue: { required: true, membership: 'ejected' }, known: true }
    }
    if (['fresh', 'idle', 'merging'].includes(status)) {
      return { queue: { required: true, membership: 'enqueued' }, known: true }
    }
    return { queue: { required: true, membership: 'unknown' }, known: false }
  } catch (error) {
    throwIfAborted(signal)
    if (isNotFound(error)) {
      return { queue: { required: true, membership: 'not-enqueued' }, known: true }
    }
    return { queue: { required: true, membership: 'unknown' }, known: false }
  }
}

export function lifecycleForMergeRequest(
  mergeRequest: GitLabMergeRequest
): HostedReviewSnapshot['lifecycle'] {
  switch (stringValue(mergeRequest.state).toLowerCase()) {
    case 'merged':
      return 'merged'
    case 'opened':
      return 'open'
    default:
      return 'closed'
  }
}

export function gitlabReadiness(
  mergeRequest: GitLabMergeRequest,
  evidenceComplete: boolean,
  conflicts: HostedReviewSnapshot['conflicts']
): HostedReviewProviderReadiness {
  if (!evidenceComplete || conflicts === 'unknown') {
    return { verdict: 'unknown', blockers: ['unknown'] }
  }
  const status = stringValue(
    mergeRequest.detailed_merge_status || mergeRequest.merge_status
  ).toLowerCase()
  if (status === 'mergeable' || status === 'can_be_merged') {
    return { verdict: 'ready', blockers: [] }
  }
  const blockerByStatus: Partial<
    Record<string, HostedReviewProviderReadiness['blockers'][number]>
  > = {
    conflict: 'conflicts',
    cannot_be_merged: 'conflicts',
    ci_must_pass: 'checks',
    ci_still_running: 'checks',
    external_status_checks: 'checks',
    not_approved: 'approvals',
    requested_changes: 'approvals',
    draft_status: 'draft',
    discussions_not_resolved: 'discussions',
    need_rebase: 'behind',
    blocked_status: 'policy',
    merge_request_blocked: 'policy',
    security_policy_violations: 'policy',
    not_open: 'policy'
  }
  const blocker = blockerByStatus[status]
  return blocker
    ? { verdict: 'blocked', blockers: [blocker] }
    : { verdict: 'unknown', blockers: ['unknown'] }
}
