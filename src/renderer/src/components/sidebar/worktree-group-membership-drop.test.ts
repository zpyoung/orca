import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  findWorktreeOwnProjectHeaderRect,
  getWorktreeGroupMembershipDropTarget,
  type WorktreeGroupHeaderDropRect,
  type WorktreeOwnRepoSectionRect
} from './worktree-group-membership-drop'

type DraggedWorktree = Pick<Worktree, 'id' | 'repoId' | 'projectGroupId'>

function grouped(projectGroupId: string | null): DraggedWorktree {
  return { id: 'w1', repoId: 'repo-1', projectGroupId }
}

const GROUP_A: WorktreeGroupHeaderDropRect = { groupId: 'group-a', top: 100, bottom: 150 }
const GROUP_B: WorktreeGroupHeaderDropRect = { groupId: 'group-b', top: 200, bottom: 250 }
const OWN_REPO_SECTION: WorktreeOwnRepoSectionRect = { top: 300, bottom: 350 }

describe('getWorktreeGroupMembershipDropTarget', () => {
  it('returns join when the pointer is inside a group header the worktree is not in', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 125,
        groupHeaderRects: [GROUP_A, GROUP_B],
        draggedWorktree: grouped(null),
        ownRepoSectionRect: null
      })
    ).toEqual({ kind: 'join', groupId: 'group-a' })
  })

  it('returns leave when the pointer is inside the own-repo section and the worktree is grouped', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 325,
        groupHeaderRects: [],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: OWN_REPO_SECTION
      })
    ).toEqual({ kind: 'leave' })
  })

  it('returns none when the pointer is outside every rect', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 500,
        groupHeaderRects: [GROUP_A, GROUP_B],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: OWN_REPO_SECTION
      })
    ).toEqual({ kind: 'none' })
  })

  it('returns none when hovering the group the worktree is already in, instead of a redundant join', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 125,
        groupHeaderRects: [GROUP_A, GROUP_B],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: null
      })
    ).toEqual({ kind: 'none' })
  })

  it('never returns leave when ownRepoSectionRect is null, even though the worktree is grouped', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 325,
        groupHeaderRects: [],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: null
      })
    ).toEqual({ kind: 'none' })
  })

  it('returns none for an ungrouped worktree hovering its own repo section (nothing to leave)', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 325,
        groupHeaderRects: [],
        draggedWorktree: grouped(null),
        ownRepoSectionRect: OWN_REPO_SECTION
      })
    ).toEqual({ kind: 'none' })
  })

  it('returns none when there are no rects at all', () => {
    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 125,
        groupHeaderRects: [],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: null
      })
    ).toEqual({ kind: 'none' })
  })

  describe('group header rect boundaries (inclusive on both edges)', () => {
    it('hits exactly at top', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 100,
          groupHeaderRects: [GROUP_A],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'join', groupId: 'group-a' })
    })

    it('hits exactly at bottom', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 150,
          groupHeaderRects: [GROUP_A],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'join', groupId: 'group-a' })
    })

    it('misses just above top', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 99,
          groupHeaderRects: [GROUP_A],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'none' })
    })

    it('misses just below bottom', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 151,
          groupHeaderRects: [GROUP_A],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'none' })
    })
  })

  describe('own-repo-section rect boundaries (inclusive on both edges)', () => {
    it('hits exactly at top', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 300,
          groupHeaderRects: [],
          draggedWorktree: grouped('group-a'),
          ownRepoSectionRect: OWN_REPO_SECTION
        })
      ).toEqual({ kind: 'leave' })
    })

    it('hits exactly at bottom', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 350,
          groupHeaderRects: [],
          draggedWorktree: grouped('group-a'),
          ownRepoSectionRect: OWN_REPO_SECTION
        })
      ).toEqual({ kind: 'leave' })
    })

    it('misses just above top', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 299,
          groupHeaderRects: [],
          draggedWorktree: grouped('group-a'),
          ownRepoSectionRect: OWN_REPO_SECTION
        })
      ).toEqual({ kind: 'none' })
    })

    it('misses just below bottom', () => {
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 351,
          groupHeaderRects: [],
          draggedWorktree: grouped('group-a'),
          ownRepoSectionRect: OWN_REPO_SECTION
        })
      ).toEqual({ kind: 'none' })
    })
  })

  describe('overlapping group header rects', () => {
    it('picks the topmost rect (smallest top) when the later rect in array order overlaps it', () => {
      const upper: WorktreeGroupHeaderDropRect = { groupId: 'upper', top: 100, bottom: 200 }
      const lower: WorktreeGroupHeaderDropRect = { groupId: 'lower', top: 120, bottom: 220 }

      // upper is listed first yet has the smaller top; a "last match wins" bug
      // would return "lower" here, so this can't pass by coincidence of order.
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 150,
          groupHeaderRects: [upper, lower],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'join', groupId: 'upper' })
    })

    it('picks the topmost rect even when it is listed after the overlapping one', () => {
      const upper: WorktreeGroupHeaderDropRect = { groupId: 'upper', top: 100, bottom: 200 }
      const lower: WorktreeGroupHeaderDropRect = { groupId: 'lower', top: 120, bottom: 220 }

      // upper is listed last yet still wins, proving the pick is by geometry,
      // not by array position, in either direction.
      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 150,
          groupHeaderRects: [lower, upper],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'join', groupId: 'upper' })
    })

    it('breaks an exact top tie by keeping the first rect measured', () => {
      const first: WorktreeGroupHeaderDropRect = { groupId: 'first', top: 100, bottom: 200 }
      const second: WorktreeGroupHeaderDropRect = { groupId: 'second', top: 100, bottom: 200 }

      expect(
        getWorktreeGroupMembershipDropTarget({
          pointerY: 150,
          groupHeaderRects: [first, second],
          draggedWorktree: grouped(null),
          ownRepoSectionRect: null
        })
      ).toEqual({ kind: 'join', groupId: 'first' })
    })
  })

  it('prefers join over leave when a header rect and the own-repo section overlap', () => {
    const overlappingHeader: WorktreeGroupHeaderDropRect = {
      groupId: 'group-b',
      top: 300,
      bottom: 350
    }

    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 325,
        groupHeaderRects: [overlappingHeader],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: OWN_REPO_SECTION
      })
    ).toEqual({ kind: 'join', groupId: 'group-b' })
  })

  it("returns none when hovering the current group's own header, even though it overlaps the own-repo section", () => {
    // Regression: the header hit must win over the leave check regardless of
    // which group it belongs to, not just when it belongs to a different one.
    const overlappingCurrentHeader: WorktreeGroupHeaderDropRect = {
      groupId: 'group-a',
      top: 300,
      bottom: 350
    }

    expect(
      getWorktreeGroupMembershipDropTarget({
        pointerY: 325,
        groupHeaderRects: [overlappingCurrentHeader],
        draggedWorktree: grouped('group-a'),
        ownRepoSectionRect: OWN_REPO_SECTION
      })
    ).toEqual({ kind: 'none' })
  })
})

describe('findWorktreeOwnProjectHeaderRect', () => {
  type Rect = { repoId: string; top: number; bottom: number }

  const ANCHOR: Rect = { repoId: 'repo-local', top: 400, bottom: 430 }
  const OTHER_PROJECT: Rect = { repoId: 'repo-other', top: 500, bottom: 530 }

  it("matches the anchor rect for a worktree in a merged project's non-anchor repo", () => {
    // Regression: a logical project header merges host setups under one anchor
    // repo, so the DOM never carries the ssh sibling's id — matching on repoId
    // left drag-to-leave silently unreachable for worktrees in that sibling.
    expect(
      findWorktreeOwnProjectHeaderRect({
        rects: [ANCHOR, OTHER_PROJECT],
        ownProjectHeaderKey: 'project:proj-1',
        projectHeaderKeyByRepoId: new Map([
          ['repo-local', 'project:proj-1'],
          ['repo-other', 'project:proj-2']
        ])
      })
    ).toBe(ANCHOR)
  })

  it('returns null when no rendered header belongs to the same logical project', () => {
    expect(
      findWorktreeOwnProjectHeaderRect({
        rects: [OTHER_PROJECT],
        ownProjectHeaderKey: 'project:proj-1',
        projectHeaderKeyByRepoId: new Map([['repo-other', 'project:proj-2']])
      })
    ).toBeNull()
  })

  it('still matches an unmerged repo whose header key is its own repo key', () => {
    expect(
      findWorktreeOwnProjectHeaderRect({
        rects: [ANCHOR],
        ownProjectHeaderKey: 'repo:repo-local',
        projectHeaderKeyByRepoId: new Map([['repo-local', 'repo:repo-local']])
      })
    ).toBe(ANCHOR)
  })
})
