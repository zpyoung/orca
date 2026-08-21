import type { WorktreeDragGroup } from './worktree-manual-order'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import { needsWorktreeDragGroup } from './fork-worktree-groups/worktree-drag-group-key'

export type WorktreeDragUnitGroup = WorktreeDragGroup & {
  units: { worktreeId: string; worktreeIds: string[] }[]
}

type WorktreeDragUnitRow =
  | { type: 'host-header' }
  | { type: 'header'; key: string }
  | { type: 'item'; worktree: { id: string }; depth: number; sectionKey: string }
  | { type: 'imported-worktrees-card' }
  | { type: 'new-external-worktrees-inbox' }
  | { type: 'pending-creation' }
  | { type: 'folder-workspace' }

export function getWorktreeDragUnitGroups(
  rows: readonly WorktreeDragUnitRow[]
): WorktreeDragUnitGroup[] {
  const groups: WorktreeDragUnitGroup[] = []
  let current: { key: string; units: WorktreeDragUnitGroup['units'] } | null = null
  const naturalWorktreeIds = new Set(
    rows.flatMap((row) =>
      row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
    )
  )

  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, units: [] }
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      continue
    }
    if (needsWorktreeDragGroup(current?.key ?? null, row.sectionKey)) {
      current = { key: row.sectionKey, units: [] }
      groups.push({
        key: current.key,
        units: current.units,
        worktreeIds: current.units.map((unit) => unit.worktreeId)
      })
    }
    const currentGroup = current!
    if (row.depth > 0 && currentGroup.units.length > 0) {
      currentGroup.units.at(-1)!.worktreeIds.push(row.worktree.id)
      continue
    }
    currentGroup.units.push({ worktreeId: row.worktree.id, worktreeIds: [row.worktree.id] })
  }

  return groups
    .map((group) => ({
      ...group,
      worktreeIds: group.units.map((unit) => unit.worktreeId)
    }))
    .filter((group) => group.worktreeIds.length > 0)
}

export function getFullDropIndexForWorktreeDragUnit(args: {
  groups: readonly WorktreeDragUnitGroup[]
  sourceGroupKey: string
  dropIndex: number
}): number {
  const group = args.groups.find((candidate) => candidate.key === args.sourceGroupKey)
  if (!group) {
    return args.dropIndex
  }
  const boundedDropIndex = Math.max(0, Math.min(group.units.length, args.dropIndex))
  let fullDropIndex = 0
  for (let index = 0; index < boundedDropIndex; index++) {
    fullDropIndex += group.units[index]?.worktreeIds.length ?? 0
  }
  return fullDropIndex
}
