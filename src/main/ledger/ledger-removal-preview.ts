import {
  LedgerError,
  type LedgerOwner,
  type LedgerRequest,
  type LedgerResponse
} from '../../shared/ledger'
import type { LedgerCatalog } from './ledger-owner-resolution'
import type { LedgerStore } from './ledger-store'

export function ledgerRemovalPreview(
  request: LedgerRequest,
  catalog: LedgerCatalog,
  store: LedgerStore,
  runtime: LedgerResponse['runtime']
): LedgerResponse {
  const removal = request.removal
  const owners = new Set<string>()
  const groupIds = removal?.projectGroupId
    ? descendantGroupIds(removal.projectGroupId, catalog)
    : new Set<string>()
  for (const id of groupIds) {
    owners.add(`group:${id}`)
  }
  if (removal?.repoId) {
    const repoStillRegistered =
      catalog.repos.filter((repo) => repo.id === removal.repoId).length > 1
    for (const project of catalog.projects) {
      const remains = project.sourceRepoIds.filter((id) => id !== removal.repoId)
      if (
        !repoStillRegistered &&
        project.sourceRepoIds.includes(removal.repoId) &&
        remains.length === 0
      ) {
        owners.add(`project:${project.id}`)
      }
    }
  }
  if (removal?.projectGroupId && removal.removeContainedProjects) {
    const repoIds = new Set(
      catalog.repos
        .filter((repo) => repo.projectGroupId && groupIds.has(repo.projectGroupId))
        .map((repo) => repo.id)
    )
    for (const project of catalog.projects) {
      if (project.sourceRepoIds.length && project.sourceRepoIds.every((id) => repoIds.has(id))) {
        owners.add(`project:${project.id}`)
      }
    }
  }
  const preview = [...owners]
    .map((key) => {
      const delimiter = key.indexOf(':')
      const tier = key.slice(0, delimiter) as LedgerOwner['tier']
      const id = key.slice(delimiter + 1)
      const ledger = store.findLedger({ tier, id })
      return ledger
        ? {
            ledgerId: ledger.ledgerId,
            owner: { tier, id },
            revision: ledger.revision,
            entryCount: ledger.entries.length
          }
        : null
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
  return { schemaVersion: 1, runtime, ledger: null, removalPreview: preview }
}

function descendantGroupIds(root: string, catalog: LedgerCatalog): Set<string> {
  const ids = new Set<string>()
  const queue = [root]
  while (queue.length) {
    const id = queue.pop()!
    if (ids.has(id)) {
      continue
    }
    ids.add(id)
    for (const child of catalog.groups) {
      if (child.parentGroupId === id) {
        queue.push(child.id)
      }
    }
  }
  return ids
}

export function assertRemovalPreviewMatches(
  actual: NonNullable<LedgerResponse['removalPreview']>,
  expected: { ledgerId: string; revision: number }[],
  detailsKey: 'actual' | 'currentPreview'
): void {
  if (
    actual.length !== expected.length ||
    actual.some((item) => {
      const found = expected.find((candidate) => candidate.ledgerId === item.ledgerId)
      return !found || found.revision !== item.revision
    })
  ) {
    throw new LedgerError('conflict', 'Ledger removal preview is stale', { [detailsKey]: actual })
  }
}
