import type { HostedReviewInfo } from '../../shared/hosted-review'
import type {
  HostedReviewSnapshot,
  HostedReviewSitterAction,
  HostedReviewSitterDefinition
} from '../../shared/fork-hosted-review-sitter/types'
import { getHostedReviewForBranch } from '../source-control/hosted-review'
import { getProjectSlug } from '../gitlab/client'
import {
  acquire,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  release,
  type ProjectRef
} from '../gitlab/gl-utils'
import { encodedProject } from '../gitlab/project-path-encoding'
import { gitlabJobState, stableFailureSignature } from './provider-check-normalization'
import { throwIfAborted, type HostedReviewSitterGitExecution } from './provider-git'
import { gitLabProjectFromReviewUrl } from './provider-push-target'
import {
  attachGitLabFailureSignatures,
  defaultMergeMethod,
  gitlabReadiness,
  lifecycleForMergeRequest,
  loadAllPipelineRows,
  loadBaseSha,
  loadExternalStatusChecks,
  loadQueueEvidence,
  normalizePipelineJobs,
  pipelineFromMergeRequest
} from './provider-gitlab-checks'

export type ProviderAction = Extract<
  HostedReviewSitterAction,
  { kind: 'rerun-check' | 'update-branch' | 'merge' | 'enqueue' }
>

export type GitLabPipeline = {
  id?: unknown
  sha?: unknown
  status?: unknown
  project_id?: unknown
  web_url?: unknown
}
export type GitLabMergeRequest = Record<string, unknown> & {
  head_pipeline?: GitLabPipeline | null
  pipeline?: GitLabPipeline | null
  diff_refs?: { base_sha?: unknown } | null
}
export type GitLabProject = Record<string, unknown>
export type GitLabJob = Record<string, unknown> & {
  pipeline?: GitLabPipeline | null
}
export type GitLabState = {
  snapshot: HostedReviewSnapshot
  projectRef: ProjectRef
  baseRefName: string
  sourceIdentityComplete: boolean
  project: GitLabProject
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export async function runGitLabApi(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  args: string[],
  options: { idempotent?: boolean; signal?: AbortSignal; onDispatch?: () => void } = {}
): Promise<string> {
  throwIfAborted(options.signal)
  await acquire()
  try {
    throwIfAborted(options.signal)
    options.onDispatch?.()
    const { stdout } = await glabExecFileAsync(
      ['api', ...glabHostnameArgs(projectRef, git.connectionId), ...args],
      {
        ...glabRepoExecOptions(definition.repoPath, git.connectionId, git.localGitOptions),
        ...(options.idempotent === false ? { idempotent: false } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
    return stdout
  } finally {
    release()
  }
}

export function isNotFound(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const text = [
    error instanceof Error ? error.message : String(error),
    stringValue(record?.stderr),
    stringValue(record?.stdout)
  ].join('\n')
  return /(?:HTTP\s+404|404\s+Not Found|not found)/i.test(text)
}

async function loadMergeRequest(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  signal?: AbortSignal
): Promise<GitLabMergeRequest> {
  const endpoint = `projects/${encodedProject(projectRef.path)}/merge_requests/${definition.reviewNumber}?with_merge_status_recheck=true`
  const value = JSON.parse(await runGitLabApi(definition, git, projectRef, [endpoint], { signal }))
  if (!value || typeof value !== 'object') {
    throw new Error('GitLab returned invalid merge request data.')
  }
  return value as GitLabMergeRequest
}

async function loadProject(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  projectRef: ProjectRef,
  signal?: AbortSignal
): Promise<GitLabProject> {
  const value = JSON.parse(
    await runGitLabApi(
      definition,
      git,
      projectRef,
      [`projects/${encodedProject(projectRef.path)}`],
      { signal }
    )
  )
  if (!value || typeof value !== 'object') {
    throw new Error('GitLab returned invalid project policy data.')
  }
  return value as GitLabProject
}

export async function loadGitLabState(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  fresh: boolean,
  signal?: AbortSignal
): Promise<GitLabState> {
  let cachedReview: HostedReviewInfo | null = null
  if (!fresh) {
    cachedReview = await getHostedReviewForBranch({
      repoPath: definition.repoPath,
      executionHostId: git.executionHostId,
      branch: definition.branch,
      linkedGitLabMR: definition.reviewNumber,
      active: true,
      localGitExecOptions: git.localGitOptions
    })
    throwIfAborted(signal)
    if (
      !cachedReview ||
      cachedReview.provider !== 'gitlab' ||
      cachedReview.number !== definition.reviewNumber
    ) {
      throw new Error('The armed GitLab merge request could not be found.')
    }
  }
  const projectRef =
    gitLabProjectFromReviewUrl(definition.reviewUrl, definition.reviewNumber) ??
    (await getProjectSlug(definition.repoPath, git.connectionId, {
      localGitExecOptions: git.localGitOptions
    }).catch(() => null))
  if (!projectRef) {
    throw new Error('Could not resolve the GitLab host and project for this sitter.')
  }

  const mergeRequest = await loadMergeRequest(definition, git, projectRef, signal)
  const project = await loadProject(definition, git, projectRef, signal).catch(() => {
    throwIfAborted(signal)
    return {} as GitLabProject
  })
  const pipelinePolicy = booleanValue(project.only_allow_merge_if_pipeline_succeeds)
  const externalPolicy = booleanValue(project.only_allow_merge_if_all_status_checks_passed)
  const projectPolicyComplete = pipelinePolicy !== null && externalPolicy !== null
  const headSha = stringValue(mergeRequest.sha)
  const baseRefName = stringValue(mergeRequest.target_branch)
  const reviewPushTarget = fresh ? await git.reviewPushTarget(signal) : null
  const sourceProjectId = numberValue(mergeRequest.source_project_id)
  let sourceIdentityComplete =
    Boolean(sourceProjectId) &&
    stringValue(mergeRequest.source_branch) === definition.branch &&
    (!fresh || reviewPushTarget?.branchName === definition.branch)
  const baseSha = baseRefName
    ? await loadBaseSha(definition, git, projectRef, baseRefName, signal).catch(() => {
        throwIfAborted(signal)
        return ''
      })
    : ''
  const pipeline = pipelineFromMergeRequest(mergeRequest)
  const pipelineRequired = pipelinePolicy === true
  let pipelineRows = { jobs: [] as GitLabJob[], complete: !pipelineRequired }
  if (pipeline) {
    pipelineRows = await loadAllPipelineRows(definition, git, projectRef, pipeline, signal).catch(
      () => {
        throwIfAborted(signal)
        return { jobs: [] as GitLabJob[], complete: false }
      }
    )
  }
  const normalizedJobs = normalizePipelineJobs(
    pipelineRows.jobs,
    stringValue(pipeline?.sha),
    pipelineRequired,
    project.allow_merge_on_skipped_pipeline === true
  )
  const requiredJobs = normalizedJobs.checks.filter((check) => check.required)
  if (pipelineRequired && (!pipeline || requiredJobs.length === 0)) {
    const rawPipelineState = pipeline ? gitlabJobState(pipeline.status) : 'unknown'
    const pipelineState =
      rawPipelineState === 'skipped' && project.allow_merge_on_skipped_pipeline === true
        ? 'passed'
        : rawPipelineState
    normalizedJobs.checks.push({
      checkKey: 'pipeline',
      checkId: pipeline ? `pipeline:${numberValue(pipeline.id) ?? 'unknown'}` : 'missing:pipeline',
      name: 'Pipeline',
      required: true,
      headSha,
      state: pipelineState,
      observationId: `${headSha}:pipeline:${numberValue(pipeline?.id) ?? 'missing'}:${stringValue(pipeline?.status)}`,
      failureSignature:
        pipelineState === 'failed'
          ? stableFailureSignature('pipeline', [stringValue(pipeline?.status)])
          : null
    })
  }
  const external = await loadExternalStatusChecks(
    definition,
    git,
    projectRef,
    headSha,
    externalPolicy === true,
    signal
  )
  const checks = [...normalizedJobs.checks, ...external.checks]
  const signaturesComplete = await attachGitLabFailureSignatures(
    definition,
    git,
    projectRef,
    checks,
    signal
  )
  const finalMergeRequest = await loadMergeRequest(definition, git, projectRef, signal)
  const finalHeadSha = stringValue(finalMergeRequest.sha)
  sourceIdentityComplete =
    sourceIdentityComplete &&
    numberValue(finalMergeRequest.source_project_id) === sourceProjectId &&
    stringValue(finalMergeRequest.source_branch) === definition.branch
  const pipelineHeadSha = stringValue(pipeline?.sha)
  const queue = await loadQueueEvidence(definition, git, projectRef, project, signal)
  const mergeMethod = defaultMergeMethod(project)
  let conflicts: HostedReviewSnapshot['conflicts'] =
    mergeRequest.has_conflicts === true ||
    stringValue(mergeRequest.detailed_merge_status).toLowerCase() === 'conflict'
      ? 'present'
      : mergeRequest.has_conflicts === false
        ? 'none'
        : 'unknown'
  if (conflicts === 'unknown' && headSha && baseSha) {
    conflicts = await git.simulateConflicts(headSha, baseSha, signal)
  }
  const headStable = Boolean(headSha) && finalHeadSha === headSha
  const pipelineAttached = !pipeline || (Boolean(pipelineHeadSha) && pipelineHeadSha === headSha)
  const checksComplete =
    headStable &&
    pipelineAttached &&
    pipelineRows.complete &&
    normalizedJobs.complete &&
    external.complete &&
    signaturesComplete
  const evidenceComplete =
    checksComplete &&
    sourceIdentityComplete &&
    projectPolicyComplete &&
    queue.known &&
    mergeMethod.known &&
    Boolean(baseSha && baseRefName)
  const snapshot: HostedReviewSnapshot = {
    provider: 'gitlab',
    reviewNumber: definition.reviewNumber,
    url: stringValue(mergeRequest.web_url) || cachedReview?.url || definition.reviewUrl,
    lifecycle: lifecycleForMergeRequest(mergeRequest),
    headSha,
    baseSha,
    observedAtMs: Date.now(),
    freshness: fresh ? 'live' : 'cached',
    draft: mergeRequest.draft === true || mergeRequest.work_in_progress === true,
    checks,
    checksComplete,
    providerReadiness: gitlabReadiness(mergeRequest, evidenceComplete, conflicts),
    behindBase: stringValue(mergeRequest.detailed_merge_status).toLowerCase() === 'need_rebase',
    conflicts,
    queue: queue.queue,
    defaultMergeMethod: mergeMethod.method
  }
  return { snapshot, projectRef, baseRefName, sourceIdentityComplete, project }
}

export async function readGitLabSitterSnapshot(
  definition: HostedReviewSitterDefinition,
  git: HostedReviewSitterGitExecution,
  options: { fresh: boolean }
): Promise<HostedReviewSnapshot> {
  return (await loadGitLabState(definition, git, options.fresh)).snapshot
}
