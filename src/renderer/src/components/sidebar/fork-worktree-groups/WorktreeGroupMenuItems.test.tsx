import type { PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'

const mocks = vi.hoisted(() => ({
  state: {
    projectGroups: [{ id: 'group-1', name: 'Existing group' }],
    updateWorktreeMeta: vi.fn(),
    createProjectGroup: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>
}))

vi.mock('@/components/sidebar/ProjectGroupNameDialog', () => ({
  ProjectGroupNameDialog: () => null
}))

import { WorktreeGroupMenuItems } from './WorktreeGroupMenuItems'

const worktree = (id = 'repo-1::/repo/worktrees/feature'): Worktree =>
  ({
    id,
    repoId: 'repo-1',
    displayName: 'feature',
    projectGroupId: null
  }) as Worktree

const repo = { id: 'repo-1', kind: 'git', projectGroupId: null } as unknown as Repo

function renderMenu(item: Worktree, project: Repo | null = repo): string {
  return renderToStaticMarkup(
    <WorktreeGroupMenuItems
      worktree={item}
      repo={project}
      disabled={false}
      onCreateProject={vi.fn()}
      onCreateWorktree={vi.fn()}
      onMoveProject={vi.fn()}
      onRemoveProject={vi.fn()}
    />
  )
}

describe('WorktreeGroupMenuItems', () => {
  it('integrates worktree-scoped actions for normal git worktree rows', () => {
    const markup = renderMenu(worktree())

    expect(markup).toContain('New group from worktree')
    expect(markup).toContain('Add worktree to group')
    expect(markup).not.toContain('New group from project')
    expect(markup).toContain('Move project to group')
  })

  it('keeps project removal available beside worktree membership actions', () => {
    const groupedRepo = { ...repo, projectGroupId: 'group-1' }
    const markup = renderMenu(worktree(), groupedRepo)

    expect(markup).toContain('Remove project from group')
    expect(markup).toContain('Add worktree to group')
  })

  it('falls back to project-scoped actions for folder workspaces', () => {
    const markup = renderMenu(worktree('folder:folder-1'))

    expect(markup).not.toContain('New group from worktree')
    expect(markup).not.toContain('Add worktree to group')
    expect(markup).toContain('New group from project')
    expect(markup).toContain('Move project to group')
  })

  it('does not offer a project action for a repo-less folder workspace', () => {
    const markup = renderMenu(worktree('folder:folder-1'), null)

    expect(markup).not.toContain('New group from worktree')
    expect(markup).not.toContain('New group from project')
    expect(markup).not.toContain('Add worktree to group')
  })
})
