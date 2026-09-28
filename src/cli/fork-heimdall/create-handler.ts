import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import type { EnrollResult, WatcherKindId } from '../../shared/fork-heimdall/watcher-types'
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
import { normalizeWorktreeSelectorForCaller, resolveCurrentWorktreeSelector } from '../selectors'
import {
  assertHeimdallCreateCapabilities,
  buildHeimdallCreateCandidate,
  buildHeimdallEnrollInput,
  type HeimdallCreateWorkspace
} from './create-input'

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

function formatEnrollmentResult(result: EnrollResult, kind: WatcherKindId): string {
  if (result.status === 'refused') {
    const detail =
      result.reason === 'duplicate-workspace'
        ? `This workspace already has watcher ${result.existingWatcherId}.`
        : result.reason === 'owner-not-executable'
          ? `No Heimdall owner can execute on scheduler ${result.schedulerOwner}.`
          : result.detail
    return `Heimdall enrollment refused (${result.reason}): ${detail}`
  }
  const action = result.status === 're-armed' ? 're-armed' : 'enrolled'
  return `Heimdall ${kind} watcher ${result.entry.enrollment.watcherId} ${action}.`
}

function createHandler(kind: WatcherKindId): CommandHandler {
  return async (context) => {
    const candidate = buildHeimdallCreateCandidate(context.flags, context.cwd, kind)
    const status = await context.client.call<RuntimeStatus>('status.get')
    const runtimeCapabilities = status.result.capabilities ?? []
    assertHeimdallCreateCapabilities(candidate, runtimeCapabilities)
    const folderWorkspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
    const isCurrent =
      candidate.worktreeSelector === 'active' || candidate.worktreeSelector === 'current'
    const selector =
      isCurrent && !context.client.isRemote && folderWorkspaceId?.startsWith('folder:')
        ? folderWorkspaceId
        : isCurrent
          ? await resolveCurrentWorktreeSelector(context.cwd, context.client)
          : await normalizeWorktreeSelectorForCaller(
              candidate.worktreeSelector,
              context.cwd,
              context.client
            )
    const workspace = await resolveCreateWorkspace(context, selector)
    const input = buildHeimdallEnrollInput(candidate, workspace, runtimeCapabilities)
    const response = await context.client.call<EnrollResult>(HEIMDALL_CHANNELS.enroll, {
      input,
      owner: null
    })
    if (response.result.status === 'refused') {
      process.exitCode = 1
    }
    printResult(response, context.json, (result) => formatEnrollmentResult(result, kind))
  }
}

export const HEIMDALL_CREATE_HANDLERS: Record<string, CommandHandler> = {
  'heimdall create objective': createHandler('objective'),
  'heimdall create hosted-review': createHandler('hosted-review')
}
