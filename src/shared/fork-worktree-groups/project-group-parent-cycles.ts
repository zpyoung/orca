import type { ProjectGroup } from '../types'

// Why: a multi-node parent cycle survives the self/missing-parent checks above, and
// buildRows walks down from roots, so an unbroken cycle leaves every group in it
// unreachable and therefore never rendered.
export function breakProjectGroupParentCycles(groups: readonly ProjectGroup[]): void {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const status = new Map<string, 'visiting' | 'resolved'>()

  for (const start of groups) {
    if (status.get(start.id) === 'resolved') {
      continue
    }
    const path: ProjectGroup[] = []
    let current: ProjectGroup | undefined = start
    while (current && status.get(current.id) !== 'resolved') {
      if (status.get(current.id) === 'visiting') {
        // `current` is already on this walk's path, so the edge closing the loop is the
        // last hop taken to reach it. Cutting just that edge frees every group on the path.
        path.at(-1)!.parentGroupId = null
        break
      }
      status.set(current.id, 'visiting')
      path.push(current)
      current = current.parentGroupId != null ? groupById.get(current.parentGroupId) : undefined
    }
    for (const visited of path) {
      status.set(visited.id, 'resolved')
    }
  }
}
