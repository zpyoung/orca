import { HEIMDALL_CHANNELS, type EnrollSuccess } from '../../shared/fork-heimdall/api'
import type { WatcherKindId } from '../../shared/fork-heimdall/watcher-types'
import type { RuntimeWorktreeRecord, RuntimeStatus } from '../../shared/runtime-types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  assertHeimdallCreateCapabilities,
  buildHeimdallCreateCandidate,
  buildHeimdallEnrollInput,
  type HeimdallCreateWorkspace
} from './create-input'
import { resolveHeimdallWorkspaceSelector } from './watcher-row'

type RepoHostInfo = Pick<Repo, 'kind' | 'connectionId' | 'executionHostId'>

function assertLocalCreateWorkspace(worktree: RuntimeWorktreeRecord, repo?: RepoHostInfo): void {
  if (
    worktree.runtimeOwnerEnvironmentId ||
    getWorktreeExecutionHostId(worktree, repo) !== LOCAL_EXECUTION_HOST_ID ||
    (repo !== undefined && getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID)
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Heimdall create requires a workspace owned by the selected runtime and a local execution host. Remote SSH/runtime workspaces are unsupported; choose a workspace on this runtime.'
    )
  }
}

async function resolveCreateWorkspace(
  context: HandlerContext,
  selector: string
): Promise<HeimdallCreateWorkspace> {
  const response = await context.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree: selector
  })
  const worktree = response.result.worktree
  assertLocalCreateWorkspace(worktree)
  if (worktree.id.startsWith('folder:')) {
    return { repoId: worktree.repoId, worktreeId: worktree.id, workspaceKind: 'folder' }
  }
  const repo = await context.client.call<{ repo: RepoHostInfo }>('repo.show', {
    repo: worktree.repoId
  })
  assertLocalCreateWorkspace(worktree, repo.result.repo)
  const isFolder = repo.result.repo.kind === 'folder'
  return {
    repoId: worktree.repoId,
    worktreeId: isFolder ? null : worktree.id,
    workspaceKind: isFolder ? 'folder' : 'git'
  }
}

function formatEnrollmentResult(result: EnrollSuccess, kind: WatcherKindId): string {
  const action = result.status === 're-armed' ? 're-armed' : 'enrolled'
  return `Heimdall ${kind} watcher ${result.entry.enrollment.watcherId} ${action}.`
}

function createHandler(kind: WatcherKindId): CommandHandler {
  return async (context) => {
    const candidate = buildHeimdallCreateCandidate(context.flags, context.cwd, kind)
    const status = await context.client.call<RuntimeStatus>('status.get')
    const runtimeCapabilities = status.result.capabilities ?? []
    assertHeimdallCreateCapabilities(candidate, runtimeCapabilities)
    const selector = await resolveHeimdallWorkspaceSelector(
      candidate.worktreeSelector,
      context.cwd,
      context.client
    )
    const workspace = await resolveCreateWorkspace(context, selector)
    const input = buildHeimdallEnrollInput(candidate, workspace, runtimeCapabilities)
    const response = await context.client.call<EnrollSuccess>(HEIMDALL_CHANNELS.enroll, {
      input,
      owner: null
    })
    printResult(response, context.json, (result) => formatEnrollmentResult(result, kind))
  }
}

export const HEIMDALL_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'heimdall create objective': createHandler('objective'),
  'heimdall create hosted-review': createHandler('hosted-review')
}
