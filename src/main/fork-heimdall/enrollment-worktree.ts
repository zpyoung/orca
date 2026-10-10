import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export type EnrollmentNewWorktreeRequest = Readonly<{
  name: string
  baseBranch?: string
}>

export type EnrollmentWorktreeContext = Readonly<{
  label: string
  diagnosticPrefix: string
}>

async function listNamedWorktreeIds(
  runtime: OrcaRuntimeService,
  repo: Repo,
  name: string
): Promise<string[]> {
  runtime.invalidateWorktreeCatalog(repo.id)
  const listed = await runtime.listManagedWorktrees(`id:${repo.id}`, Number.MAX_SAFE_INTEGER)
  return listed.worktrees
    .filter((worktree) => worktree.displayName === name)
    .map((worktree) => worktree.id)
}

async function removeStrandedWorktrees(
  runtime: OrcaRuntimeService,
  repo: Repo,
  name: string,
  preexisting: ReadonlySet<string>,
  diagnosticPrefix: string
): Promise<void> {
  try {
    const stranded = (await listNamedWorktreeIds(runtime, repo, name)).filter(
      (id) => !preexisting.has(id)
    )
    for (const id of stranded) {
      await enrollmentWorktreeRollback(
        runtime,
        id,
        getRepoExecutionHostId(repo),
        diagnosticPrefix
      )()
    }
  } catch (error) {
    console.warn(`${diagnosticPrefix} enrollment worktree rollback failed`, error)
  }
}

/** Creates an inactive, parentless managed worktree and removes any newly stranded checkout on failure. */
export async function createEnrollmentWorktree(
  runtime: OrcaRuntimeService,
  repo: Repo,
  request: EnrollmentNewWorktreeRequest,
  context: EnrollmentWorktreeContext
) {
  const preexisting = new Set(await listNamedWorktreeIds(runtime, repo, request.name))
  try {
    return await runtime.createManagedWorktree({
      repoSelector: `id:${repo.id}`,
      name: request.name,
      ...(request.baseBranch ? { baseBranch: request.baseBranch } : {}),
      displayName: request.name,
      activate: false,
      lineage: { noParent: true },
      comment: `${context.label} enrollment: ${request.name}`
    })
  } catch (error) {
    await removeStrandedWorktrees(
      runtime,
      repo,
      request.name,
      preexisting,
      context.diagnosticPrefix
    )
    throw error
  }
}

/** Returns a host-scoped once-only removal for a worktree created by a refused enrollment. */
export function enrollmentWorktreeRollback(
  runtime: OrcaRuntimeService,
  worktreeId: string,
  hostId: ExecutionHostId,
  diagnosticPrefix: string
): () => Promise<void> {
  let removal: Promise<void> | null = null
  return () => {
    removal ??= runtime.removeManagedWorktree(`id:${worktreeId}`, { force: true, hostId }).then(
      () => undefined,
      (error: unknown) => {
        console.warn(`${diagnosticPrefix} enrollment worktree rollback failed`, error)
      }
    )
    return removal
  }
}
