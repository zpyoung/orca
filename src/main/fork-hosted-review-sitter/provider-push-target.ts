import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import {
  acquire as acquireGitHub,
  ghExecFileAsync,
  ghRepoExecOptions,
  githubRepoContext,
  parseGitHubRemoteIdentity,
  release as releaseGitHub
} from '../github/gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../github/github-api-repository'
import { getProjectSlug } from '../gitlab/client'
import {
  acquire as acquireGitLab,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGitLabProjectRef,
  release as releaseGitLab,
  type ProjectRef
} from '../gitlab/gl-utils'
import { encodedProject } from '../gitlab/project-path-encoding'

export type HostedReviewSitterPushTargetContext = {
  connectionId: string | null
  localGitOptions: LocalProjectWorktreeGitOptions
  exec(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }>
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function gitLabProjectFromReviewUrl(
  reviewUrl: string,
  reviewNumber: number
): ProjectRef | null {
  try {
    const url = new URL(reviewUrl)
    const match = url.pathname.replace(/\/+$/, '').match(/^\/(.+)\/-\/merge_requests\/(\d+)$/)
    if (!match || Number(match[2]) !== reviewNumber) {
      return null
    }
    const path = match[1]
      ?.split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    return path ? { host: url.host, path } : null
  } catch {
    return null
  }
}

export function gitHubRepositoryFromReviewUrl(
  reviewUrl: string,
  reviewNumber: number
): GitHubApiRepository | null {
  try {
    const url = new URL(reviewUrl)
    const match = url.pathname.replace(/\/+$/, '').match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/)
    if (!match || Number(match[3]) !== reviewNumber || !match[1] || !match[2]) {
      return null
    }
    return {
      host: url.host,
      owner: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2])
    }
  } catch {
    return null
  }
}

async function resolveGitHubPushTarget(
  definition: HostedReviewSitterDefinition,
  context: HostedReviewSitterPushTargetContext,
  signal?: AbortSignal
): Promise<GitPushTarget | null> {
  const targetRepository = gitHubRepositoryFromReviewUrl(
    definition.reviewUrl,
    definition.reviewNumber
  )
  if (!targetRepository) {
    return null
  }
  await acquireGitHub()
  let sourceOwner = ''
  let sourceRepo = ''
  let sourceBranch = ''
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        `repos/${targetRepository.owner}/${targetRepository.repo}/pulls/${definition.reviewNumber}`
      ],
      {
        ...ghRepoExecOptions(
          githubRepoContext(definition.repoPath, context.connectionId, context.localGitOptions)
        ),
        ...githubHostExecOptions(targetRepository),
        ...(signal ? { signal } : {})
      }
    )
    const review = JSON.parse(stdout) as {
      head?: { ref?: unknown; repo?: { full_name?: unknown } | null }
    }
    const sourcePath = stringValue(review.head?.repo?.full_name)
    const separator = sourcePath.indexOf('/')
    sourceOwner = separator > 0 ? sourcePath.slice(0, separator) : ''
    sourceRepo = separator > 0 ? sourcePath.slice(separator + 1) : ''
    sourceBranch = stringValue(review.head?.ref)
  } finally {
    releaseGitHub()
  }
  if (!sourceOwner || !sourceRepo || sourceBranch !== definition.branch) {
    return null
  }

  const remotes = (await context.exec(['remote'], signal)).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  const candidates = new Map<string, GitPushTarget>()
  for (const remoteName of remotes) {
    const pushUrls = (
      await context.exec(['remote', 'get-url', '--push', '--all', remoteName], signal)
    ).stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    for (const remoteUrl of pushUrls) {
      const remote = parseGitHubRemoteIdentity(remoteUrl)
      if (
        remote?.host.toLowerCase() === (targetRepository.host ?? 'github.com').toLowerCase() &&
        remote.owner.toLowerCase() === sourceOwner.toLowerCase() &&
        remote.repo.toLowerCase() === sourceRepo.toLowerCase()
      ) {
        candidates.set(remoteUrl, { remoteName, branchName: sourceBranch, remoteUrl })
      }
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null
}

async function resolveGitLabPushTarget(
  definition: HostedReviewSitterDefinition,
  context: HostedReviewSitterPushTargetContext,
  signal?: AbortSignal
): Promise<GitPushTarget | null> {
  const targetProject =
    gitLabProjectFromReviewUrl(definition.reviewUrl, definition.reviewNumber) ??
    (await getProjectSlug(definition.repoPath, context.connectionId, {
      localGitExecOptions: context.localGitOptions
    }).catch(() => null))
  if (!targetProject) {
    return null
  }
  await acquireGitLab()
  let sourceProjectId: number | null = null
  let sourceBranch = ''
  let sourceProjectPath = ''
  try {
    const options = {
      ...glabRepoExecOptions(definition.repoPath, context.connectionId, context.localGitOptions),
      ...(signal ? { signal } : {})
    }
    const { stdout: mergeRequestJson } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(targetProject, context.connectionId),
        `projects/${encodedProject(targetProject.path)}/merge_requests/${definition.reviewNumber}`
      ],
      options
    )
    const mergeRequest = JSON.parse(mergeRequestJson) as Record<string, unknown>
    sourceProjectId =
      typeof mergeRequest.source_project_id === 'number' ? mergeRequest.source_project_id : null
    sourceBranch = stringValue(mergeRequest.source_branch)
    if (!sourceProjectId || sourceBranch !== definition.branch) {
      return null
    }
    const { stdout: sourceProjectJson } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(targetProject, context.connectionId),
        `projects/${sourceProjectId}`
      ],
      options
    )
    const sourceProject = JSON.parse(sourceProjectJson) as Record<string, unknown>
    sourceProjectPath = stringValue(sourceProject.path_with_namespace)
  } finally {
    releaseGitLab()
  }
  if (!sourceProjectPath) {
    return null
  }

  const remotes = (await context.exec(['remote'], signal)).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  const candidates = new Map<string, GitPushTarget>()
  for (const remoteName of remotes) {
    const pushUrls = (
      await context.exec(['remote', 'get-url', '--push', '--all', remoteName], signal)
    ).stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    for (const remoteUrl of pushUrls) {
      const remoteProject = parseGitLabProjectRef(remoteUrl, [targetProject.host])
      if (
        remoteProject?.host.toLowerCase() === targetProject.host.toLowerCase() &&
        remoteProject.path.toLowerCase() === sourceProjectPath.toLowerCase()
      ) {
        candidates.set(remoteUrl, { remoteName, branchName: sourceBranch, remoteUrl })
      }
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null
}

export async function resolveHostedReviewSitterPushTarget(
  definition: HostedReviewSitterDefinition,
  context: HostedReviewSitterPushTargetContext,
  signal?: AbortSignal
): Promise<GitPushTarget | null> {
  if (definition.provider === 'github') {
    return resolveGitHubPushTarget(definition, context, signal)
  }
  return resolveGitLabPushTarget(definition, context, signal)
}
