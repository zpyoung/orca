import { LedgerError, type LedgerOwner, type LedgerRequest } from '../../shared/ledger'
import type { Project, ProjectGroup, FolderWorkspace, Worktree, Repo } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

export type LedgerCatalog = {
  projects: Project[]
  groups: ProjectGroup[]
  folders: FolderWorkspace[]
  worktrees: Worktree[]
  repos: Repo[]
}

export function liveLedgerOwners(catalog: LedgerCatalog): LedgerOwner[] {
  return [
    ...catalog.projects.map((project) => ({ tier: 'project' as const, id: project.id })),
    ...catalog.groups.map((group) => ({ tier: 'group' as const, id: group.id }))
  ]
}

export function resolveLedgerOwner(
  request: LedgerRequest,
  catalog: LedgerCatalog,
  channel: 'cli' | 'ui'
): LedgerOwner | undefined {
  const target = request.target
  if (
    target?.ledgerId &&
    (request.operation === 'list' || request.operation === 'show' || request.operation === 'review')
  ) {
    return undefined
  }
  if (target?.ledgerId && request.operation !== 'catalog') {
    if (channel !== 'ui') {
      throw new LedgerError('forbidden', 'Detached ledger mutation is UI-only')
    }
    return undefined
  }
  if (target?.owner) {
    if (
      !liveLedgerOwners(catalog).some(
        (owner) => owner.tier === target.owner!.tier && owner.id === target.owner!.id
      )
    ) {
      throw new LedgerError('owner-missing', 'Ledger owner is not live')
    }
    return target.owner
  }
  if (!target?.workspaceId) {
    return undefined
  }
  const worktree = catalog.worktrees.find((item) => item.id === target.workspaceId)
  if (!worktree) {
    const folder = catalog.folders.find(
      (item) => item.id === target.workspaceId || folderWorkspaceKey(item.id) === target.workspaceId
    )
    if (!folder) {
      throw new LedgerError('workspace-missing', 'Workspace is not live')
    }
    return resolveLedgerGroupByMembership(target.groupSelector, folder.projectGroupId, catalog)
  }
  if (target.group || target.groupSelector) {
    return resolveLedgerGroup(target.groupSelector, worktree, catalog)
  }
  const project = worktree.projectId
    ? catalog.projects.find(
        (item) => item.id === worktree.projectId && item.sourceRepoIds.includes(worktree.repoId)
      )
    : undefined
  const fallback =
    project ??
    (() => {
      const matches = catalog.projects.filter((item) =>
        item.sourceRepoIds.includes(worktree.repoId)
      )
      return matches.length === 1 ? matches[0] : undefined
    })()
  if (!fallback) {
    throw new LedgerError('owner-ambiguous', 'Workspace project owner is missing or ambiguous')
  }
  return { tier: 'project', id: fallback.id }
}

function resolveLedgerGroup(
  selector: string | undefined,
  worktree: Worktree,
  catalog: LedgerCatalog
): LedgerOwner {
  const membership =
    worktree.projectGroupId ??
    catalog.repos.find((repo) => repo.id === worktree.repoId)?.projectGroupId ??
    undefined
  if (!membership) {
    throw new LedgerError('group-missing', 'Workspace has no group membership')
  }
  return resolveLedgerGroupByMembership(selector, membership, catalog)
}

function resolveLedgerGroupByMembership(
  selector: string | undefined,
  membership: string,
  catalog: LedgerCatalog
): LedgerOwner {
  const eligible: ProjectGroup[] = []
  let current = catalog.groups.find((group) => group.id === membership)
  while (current) {
    eligible.push(current)
    current = current.parentGroupId
      ? catalog.groups.find((group) => group.id === current!.parentGroupId)
      : undefined
  }
  if (!selector) {
    return { tier: 'group', id: membership }
  }
  const exact = eligible.filter((group) => group.id === selector)
  const named = exact.length ? exact : eligible.filter((group) => group.name === selector)
  if (named.length !== 1) {
    throw new LedgerError('group-ambiguous', 'Group selector is missing or ambiguous', {
      eligible: eligible.map((group) => ({ id: group.id, name: group.name }))
    })
  }
  return { tier: 'group', id: named[0].id }
}
