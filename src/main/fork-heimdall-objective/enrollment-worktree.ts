import type { ExecutionHostId } from '../../shared/execution-host'
import type { ObjectiveNewWorktreeRequest } from '../../shared/fork-heimdall-objective/contract-types'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Creates an independent, inactive workspace for an objective enrollment on its repo's host. */
export async function createObjectiveEnrollmentWorktree(
  runtime: OrcaRuntimeService,
  repo: Repo,
  request: ObjectiveNewWorktreeRequest
) {
  return runtime.createManagedWorktree({
    repoSelector: `id:${repo.id}`,
    name: request.name,
    ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
    displayName: request.name,
    activate: false,
    lineage: { noParent: true },
    comment: `Objective enrollment: ${request.name}`
  })
}

/** Removes a workspace created by a refused objective enrollment on its execution host. */
export async function rollbackObjectiveEnrollmentWorktree(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  hostId: ExecutionHostId
): Promise<void> {
  await runtime.removeManagedWorktree(`id:${worktreeId}`, { force: true, hostId })
}
