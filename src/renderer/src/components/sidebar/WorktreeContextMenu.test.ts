import { describe, expect, it, vi } from 'vitest'
import {
  isContextWorktreeDeletable,
  shouldUseNativeContextMenu,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRemoveProjectFromContextMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldContinueDeleteSiblingPositionRestore,
  getWorktreeParentPickerAnchor,
  getWorktreeParentPickerLabel,
  hasWorktreeParentLink,
  isWorktreeParentPickerDisabled,
  planWorkspaceStatusAssignment,
  selectMenuScopedMap,
  addWorktreeToGroup,
  removeWorktreeFromGroup,
  createGroupFromWorktree,
  getWorktreeGroupMenuVisibility,
  shouldShowRemoveWorktreeFromGroup,
  shouldRevealWorktreeDeveloperMenu
} from './WorktreeContextMenu'
import type {
  ProjectGroup,
  Worktree,
  WorktreeLineage,
  WorkspaceStatusDefinition
} from '../../../../shared/types'

describe('shouldRevealWorktreeDeveloperMenu', () => {
  it('stays hidden for an ordinary right-click', () => {
    expect(
      shouldRevealWorktreeDeveloperMenu({ developerMenuRevealed: false, isMultiContext: false })
    ).toBe(false)
  })

  it('reveals when Option/Alt was held at open time', () => {
    expect(
      shouldRevealWorktreeDeveloperMenu({ developerMenuRevealed: true, isMultiContext: false })
    ).toBe(true)
  })

  // Why: the parking action targets one workspace, so it must not appear for a
  // multi-select context even with the modifier held.
  it('stays hidden for a multi-workspace selection', () => {
    expect(
      shouldRevealWorktreeDeveloperMenu({ developerMenuRevealed: true, isMultiContext: true })
    ).toBe(false)
  })
})

describe('selectMenuScopedMap (delete-teardown re-render guard)', () => {
  // Why: the closed menu wrapper must stay inert to delete teardown's high-churn
  // set()s. The guard is referential stability — when closed, the selector must
  // return the SAME `empty` reference even as the live map identity changes each
  // teardown set(), so Zustand's Object.is equality short-circuits the subscription
  // and the (common) closed wrapper does not re-render. These assertions pin that
  // contract; if they regress, every visible card re-renders on every teardown set()
  // and worktree-card hover popovers stall during a delete.
  it('returns the stable empty sentinel when the menu is closed', () => {
    const empty = Object.freeze({})
    const liveA = { 'wt-1': ['pty-1'] }
    const liveB = { 'wt-2': ['pty-2'] }
    // Live map identity churns across teardown set()s, yet a closed wrapper keeps
    // the same reference — no subscription wakeup.
    expect(selectMenuScopedMap(false, liveA, empty)).toBe(empty)
    expect(selectMenuScopedMap(false, liveB, empty)).toBe(empty)
    expect(selectMenuScopedMap(false, liveA, empty)).toBe(selectMenuScopedMap(false, liveB, empty))
  })

  it('returns the live map synchronously once the menu is open', () => {
    const empty = Object.freeze({})
    const live = { 'wt-1': ['pty-1'] }
    // The render where menuOpen flips true must read real data so menu items
    // (sleep/delete/lineage) reflect live tabs/ptys/delete state.
    expect(selectMenuScopedMap(true, live, empty)).toBe(live)
  })
})

describe('shouldUseNativeContextMenu', () => {
  it('uses the browser context menu for marked hovercard content', () => {
    const target = {
      closest: (selector: string) =>
        selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('uses the browser context menu for text nodes inside marked content', () => {
    const target = {
      parentElement: {
        closest: (selector: string) =>
          selector === '[data-worktree-native-context-menu]' ? ({} as Element) : null
      }
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(true)
  })

  it('keeps the worktree context menu for unmarked targets', () => {
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldUseNativeContextMenu(target)).toBe(false)
  })
})

describe('shouldIgnoreNestedWorktreeContextMenuScope', () => {
  it('allows the context menu scope that owns the event target', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => currentScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })

  it('ignores context menu events owned by a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      closest: () => nestedScope
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('ignores context menu events from text nodes inside a nested scope', () => {
    const currentScope = {} as EventTarget
    const nestedScope = {} as Element
    const target = {
      parentElement: {
        closest: () => nestedScope
      }
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(true)
  })

  it('allows events from unscoped targets', () => {
    const currentScope = {} as EventTarget
    const target = {
      closest: () => null
    } as unknown as EventTarget

    expect(shouldIgnoreNestedWorktreeContextMenuScope(currentScope, target)).toBe(false)
  })
})

describe('shouldSuppressContextMenuFollowUpClick', () => {
  it('suppresses the click emitted immediately after opening a context menu', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_050)).toBe(true)
  })

  it('does not suppress later unrelated clicks', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 1_700)).toBe(false)
  })

  it('does not suppress clicks that predate the context menu timestamp', () => {
    expect(shouldSuppressContextMenuFollowUpClick(1_000, 999)).toBe(false)
  })
})

describe('shouldContinueDeleteSiblingPositionRestore', () => {
  it('stops once the delete row position has settled even when the row remains mounted', () => {
    expect(
      shouldContinueDeleteSiblingPositionRestore({
        attempts: 6,
        stableFrames: 6
      })
    ).toBe(false)
  })
})

describe('parent picker context menu affordance', () => {
  it('offers unlink for valid inline-only legacy lineage after stable-update hydration', () => {
    const parent = { id: 'repo::parent', instanceId: 'parent-instance' }
    const lineage: WorktreeLineage = {
      worktreeId: 'repo::child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    }
    const child = {
      id: lineage.worktreeId,
      instanceId: lineage.worktreeInstanceId,
      lineage
    } as Worktree & { lineage: WorktreeLineage }

    expect(hasWorktreeParentLink(child, {}, {})).toBe(true)
  })

  it('uses set/change labels based on valid parent presence', () => {
    expect(getWorktreeParentPickerLabel(null)).toBe('Set Parent Worktree...')
    expect(getWorktreeParentPickerLabel('parent-1')).toBe('Change Parent Worktree...')
  })

  it('disables the parent picker while deleting or without candidates', () => {
    expect(isWorktreeParentPickerDisabled({ isDeleting: true, eligibleParentCount: 1 })).toBe(true)
    expect(isWorktreeParentPickerDisabled({ isDeleting: false, eligibleParentCount: 0 })).toBe(true)
    expect(isWorktreeParentPickerDisabled({ isDeleting: false, eligibleParentCount: 1 })).toBe(
      false
    )
  })

  it('snapshots the stable row anchor before the context menu closes', () => {
    const card = { dataset: { worktreeDragId: 'child' } } as unknown as HTMLElement
    const scope = {
      closest: (selector: string) => (selector === '[data-worktree-drag-id]' ? card : null)
    } as HTMLElement

    expect(getWorktreeParentPickerAnchor(scope, 'child')).toBe(card)
  })

  it('uses the child scope instead of climbing to a different workspace drag row', () => {
    const parentCard = { dataset: { worktreeDragId: 'parent' } } as unknown as HTMLElement
    const scope = {
      closest: (selector: string) => (selector === '[data-worktree-drag-id]' ? parentCard : null)
    } as HTMLElement

    expect(getWorktreeParentPickerAnchor(scope, 'child')).toBe(scope)
  })
})

describe('project removal from workspace context menus', () => {
  it('routes primary workspace rows to project removal in non-repo grouped views', () => {
    const gitRepo = { id: 'repo-1' }
    const folderRepo = { id: 'folder-1' }

    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(folderRepo, { isMainWorktree: true })).toBe(true)
    expect(shouldRemoveProjectFromContextMenu(gitRepo, { isMainWorktree: false })).toBe(false)
    expect(shouldRemoveProjectFromContextMenu(null, { isMainWorktree: true })).toBe(false)
  })

  it('treats additional folder workspace rows as deletable workspace rows', () => {
    const folderRepo = { kind: 'folder' as const }

    expect(isContextWorktreeDeletable({ isMainWorktree: false }, folderRepo)).toBe(true)
    expect(isContextWorktreeDeletable({ isMainWorktree: true }, folderRepo)).toBe(false)
    expect(isContextWorktreeDeletable({ isMainWorktree: false }, null)).toBe(false)
  })
})

describe('worktree-scoped project group membership', () => {
  // Why: distinct from the repo-level "Move to group"/"Remove from group" pair
  // above — these act on the individual worktree row's own projectGroupId,
  // independent of its repo's group. See handleMoveProjectToGroup for the
  // repo-scoped equivalent this mirrors.
  it('adding to a group calls updateWorktreeMeta with the chosen group id', () => {
    const updateWorktreeMeta = vi.fn()
    addWorktreeToGroup('wt-1', 'group-2', updateWorktreeMeta)
    expect(updateWorktreeMeta).toHaveBeenCalledWith('wt-1', { projectGroupId: 'group-2' })
  })

  it('removing from a group calls updateWorktreeMeta with null', () => {
    const updateWorktreeMeta = vi.fn()
    removeWorktreeFromGroup('wt-1', updateWorktreeMeta)
    expect(updateWorktreeMeta).toHaveBeenCalledWith('wt-1', { projectGroupId: null })
  })

  it('offers "remove from group" only when the worktree currently has a group', () => {
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: 'group-1' })).toBe(true)
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: null })).toBe(false)
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: undefined })).toBe(false)
  })
})

describe('getWorktreeGroupMenuVisibility', () => {
  // Why: a row must show exactly one create action — never both, never
  // neither. Pinned directly per case rather than trusted as a byproduct of
  // the other assertions.
  it('offers the worktree-scoped create action (and not the project one) on a normal row', () => {
    const visibility = getWorktreeGroupMenuVisibility(null, [{ id: 'group-1' }], 'git')
    expect(visibility.showWorktreeCreate).toBe(true)
    expect(visibility.showProjectCreate).toBe(false)
    expect(visibility.showWorktreeCreate).not.toBe(visibility.showProjectCreate)
  })

  it('falls back to the project-scoped create action for a folder-workspace row', () => {
    const visibility = getWorktreeGroupMenuVisibility('folder-1', [{ id: 'group-1' }], 'git')
    expect(visibility.showWorktreeCreate).toBe(false)
    expect(visibility.showProjectCreate).toBe(true)
    expect(visibility.showAddSubmenu).toBe(false)
    expect(visibility.showWorktreeCreate).not.toBe(visibility.showProjectCreate)
  })

  it('falls back to the project-scoped create action for a worktree in a folder-mode repo', () => {
    // Regression: only `folder:`-keyed workspaces set folderWorkspaceId, but a
    // folder-MODE repo's synthetic worktrees project through mergeFolderWorkspace,
    // which drops projectGroupId — so a worktree-scoped write would silently
    // no-op there too.
    const visibility = getWorktreeGroupMenuVisibility(null, [{ id: 'group-1' }], 'folder')
    expect(visibility.showWorktreeCreate).toBe(false)
    expect(visibility.showProjectCreate).toBe(true)
    expect(visibility.showAddSubmenu).toBe(false)
    expect(visibility.showWorktreeCreate).not.toBe(visibility.showProjectCreate)
  })

  it('offers the worktree create action but hides "add to group" when no project groups exist', () => {
    // This is what makes the *first* group reachable from a worktree row: the
    // add-to-existing-group submenu has nothing to list, but creating a new
    // group scoped to just this worktree is still on offer.
    const visibility = getWorktreeGroupMenuVisibility(null, [], 'git')
    expect(visibility.showWorktreeCreate).toBe(true)
    expect(visibility.showAddSubmenu).toBe(false)
    expect(visibility.showProjectCreate).toBe(false)
    expect(visibility.showWorktreeCreate).not.toBe(visibility.showProjectCreate)
  })

  it('treats an unset repo kind (the pre-RepoKind default) as worktree-scoped', () => {
    const visibility = getWorktreeGroupMenuVisibility(null, [{ id: 'group-1' }], undefined)
    expect(visibility.showWorktreeCreate).toBe(true)
    expect(visibility.showAddSubmenu).toBe(true)
    expect(visibility.showProjectCreate).toBe(false)
    expect(visibility.showWorktreeCreate).not.toBe(visibility.showProjectCreate)
  })
})

describe('createGroupFromWorktree', () => {
  const group = { id: 'group-9' } as ProjectGroup

  it('creates the group and assigns only that worktree to it', async () => {
    const createProjectGroup = vi.fn().mockResolvedValue(group)
    const updateWorktreeMeta = vi.fn()

    await createGroupFromWorktree('wt-1', 'Solo group', createProjectGroup, updateWorktreeMeta)

    expect(createProjectGroup).toHaveBeenCalledWith('Solo group')
    expect(updateWorktreeMeta).toHaveBeenCalledWith('wt-1', { projectGroupId: 'group-9' })
    expect(updateWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('does nothing when group creation returns null (create failed)', async () => {
    const createProjectGroup = vi.fn().mockResolvedValue(null)
    const updateWorktreeMeta = vi.fn()

    await createGroupFromWorktree('wt-1', 'Solo group', createProjectGroup, updateWorktreeMeta)

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })
})

describe('planWorkspaceStatusAssignment (context-menu "Move to Status" routing)', () => {
  // Why: this is the exact branch #10175 regressed on — the board must funnel
  // through the Linear-sync callback, the sidebar list must stay local-only. A
  // silent flip of either branch re-introduces the bug, so pin both here.
  const statuses: WorkspaceStatusDefinition[] = [
    { id: 'todo', label: 'Todo' },
    { id: 'in-review', label: 'In review' }
  ]
  const wt = (id: string, workspaceStatus: string): Worktree =>
    ({ id, workspaceStatus }) as Worktree

  it('routes to board Linear-sync with ALL selected ids when the board wired a callback', () => {
    // The board path forwards every id; moveWorktreesToStatus filters no-ops downstream.
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'todo'), wt('b', 'in-review')],
        'in-review',
        statuses,
        true
      )
    ).toEqual({ kind: 'board-sync', worktreeIds: ['a', 'b'] })
  })

  it('falls back to local-only writes of only status-changed worktrees off the board', () => {
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'todo'), wt('b', 'in-review')],
        'in-review',
        statuses,
        false
      )
    ).toEqual({ kind: 'local-only', localWriteIds: ['a'] })
  })

  it('writes nothing on the local-only path when every worktree already has the target status', () => {
    expect(
      planWorkspaceStatusAssignment(
        [wt('a', 'in-review'), wt('b', 'in-review')],
        'in-review',
        statuses,
        false
      )
    ).toEqual({ kind: 'local-only', localWriteIds: [] })
  })
})
