// FORK-COPY-OF: src/renderer/src/components/sidebar/WorktreeContextMenuView.tsx,src/renderer/src/components/sidebar/WorktreeContextMenuOverlays.tsx
// FORK-COPY-SHA: 07f4356a1678f6170a439527cd043f59b84343f0
import React, { useCallback, useState } from 'react'
import { CircleX, FolderInput, FolderPlus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectGroupNameDialog } from '@/components/sidebar/ProjectGroupNameDialog'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  addWorktreeToGroup,
  createGroupFromWorktree,
  getWorktreeGroupMenuVisibility,
  removeWorktreeFromGroup,
  shouldShowRemoveWorktreeFromGroup,
  type WorktreeGroupMenuVisibility
} from './worktree-group-menu-actions'

type ProjectGroupOption = { id: string; name: string }

type CreateProps = {
  visible: boolean
  disabled: boolean
  onCreate: () => void
}

export function WorktreeGroupCreateMenuItem({ visible, disabled, onCreate }: CreateProps) {
  if (!visible) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCreate} disabled={disabled}>
        <FolderPlus className="size-3.5" />
        {translate(
          'auto.components.sidebar.WorktreeContextMenu.308b16a770',
          'New group from worktree'
        )}
      </DropdownMenuItem>
    </>
  )
}

type MembershipProps = {
  visibility: WorktreeGroupMenuVisibility
  disabled: boolean
  projectGroups: readonly ProjectGroupOption[]
  projectGroupId: string | null | undefined
  onAdd: (groupId: string) => void
  onRemove: () => void
}

export function WorktreeGroupMembershipMenuItems({
  visibility,
  disabled,
  projectGroups,
  projectGroupId,
  onAdd,
  onRemove
}: MembershipProps) {
  if (!visibility.showAddSubmenu) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={disabled}>
          <FolderInput className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.addWorktreeToGroup',
            'Add worktree to group'
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {projectGroups.map((group) => (
            <DropdownMenuItem
              key={group.id}
              disabled={projectGroupId === group.id}
              onSelect={() => onAdd(group.id)}
            >
              <span className="max-w-48 truncate">{group.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {shouldShowRemoveWorktreeFromGroup({ projectGroupId }) ? (
        <DropdownMenuItem onSelect={onRemove} disabled={disabled}>
          <CircleX className="size-3.5" />
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.removeWorktreeFromGroup',
            'Remove worktree from group'
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

type WorktreeGroupMenuItemsProps = {
  worktree: Worktree
  repo: Repo | null | undefined
  disabled: boolean
  onCreateProject: () => void
  onCreateWorktree: () => void
  onMoveProject: (groupId: string) => void
  onRemoveProject: () => void
}

export function WorktreeGroupMenuItems({
  worktree,
  repo,
  disabled,
  onCreateProject,
  onCreateWorktree,
  onMoveProject,
  onRemoveProject
}: WorktreeGroupMenuItemsProps): React.JSX.Element {
  const projectGroups = useAppStore((state) => state.projectGroups)
  const updateWorktreeMeta = useAppStore((state) => state.updateWorktreeMeta)
  const workspaceScope = parseWorkspaceKey(worktree.id)
  const folderWorkspaceId =
    workspaceScope?.type === 'folder' ? workspaceScope.folderWorkspaceId : null
  const visibility = getWorktreeGroupMenuVisibility(
    folderWorkspaceId,
    projectGroups,
    repo?.kind,
    Boolean(repo)
  )
  const handleAdd = useCallback(
    (groupId: string) => addWorktreeToGroup(worktree.id, groupId, updateWorktreeMeta),
    [updateWorktreeMeta, worktree.id]
  )
  const handleRemove = useCallback(
    () => removeWorktreeFromGroup(worktree.id, updateWorktreeMeta),
    [updateWorktreeMeta, worktree.id]
  )

  return (
    <>
      <WorktreeGroupCreateMenuItem
        visible={visibility.showWorktreeCreate}
        disabled={disabled}
        onCreate={onCreateWorktree}
      />
      {repo ? (
        <>
          {visibility.showProjectCreate ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onCreateProject} disabled={disabled}>
                <FolderPlus className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.503ec0f8e6',
                  'New group from project'
                )}
              </DropdownMenuItem>
            </>
          ) : null}
          {projectGroups.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={disabled}>
                <FolderInput className="size-3.5" />
                {translate(
                  'auto.components.sidebar.WorktreeContextMenu.5bf97058a4',
                  'Move project to group'
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {projectGroups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    disabled={repo.projectGroupId === group.id}
                    onSelect={() => onMoveProject(group.id)}
                  >
                    <span className="max-w-48 truncate">{group.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {repo.projectGroupId ? (
            <DropdownMenuItem onSelect={onRemoveProject} disabled={disabled}>
              <CircleX className="size-3.5" />
              {translate(
                'auto.components.sidebar.WorktreeContextMenu.a2d9a2b93e',
                'Remove project from group'
              )}
            </DropdownMenuItem>
          ) : null}
        </>
      ) : null}
      <WorktreeGroupMembershipMenuItems
        visibility={visibility}
        disabled={disabled}
        projectGroups={projectGroups}
        projectGroupId={worktree.projectGroupId}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />
    </>
  )
}

type WorktreeGroupDialogProps = {
  worktree: Worktree
  dialogActiveRef: React.MutableRefObject<boolean>
}

type WorktreeGroupDialog = {
  open: boolean
  openDialog: () => void
  dialog: React.JSX.Element
}

export function useWorktreeGroupDialog({
  worktree,
  dialogActiveRef
}: WorktreeGroupDialogProps): WorktreeGroupDialog {
  const createProjectGroup = useAppStore((state) => state.createProjectGroup)
  const updateWorktreeMeta = useAppStore((state) => state.updateWorktreeMeta)
  const [open, setOpen] = useState(false)
  const openDialog = useCallback(() => {
    dialogActiveRef.current = true
    setOpen(true)
  }, [dialogActiveRef])
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      dialogActiveRef.current = nextOpen
      setOpen(nextOpen)
    },
    [dialogActiveRef]
  )
  const handleSubmit = useCallback(
    async (name: string) => {
      await createGroupFromWorktree(worktree, name, createProjectGroup, updateWorktreeMeta)
    },
    [createProjectGroup, updateWorktreeMeta, worktree]
  )

  return {
    open,
    openDialog,
    dialog: (
      <ProjectGroupNameDialog
        open={open}
        title={translate(
          'auto.components.sidebar.WorktreeContextMenu.6664418e98',
          'New Project Group'
        )}
        description={translate(
          'auto.components.sidebar.WorktreeContextMenu.3ae4748032',
          'Create a group and move this worktree into it.'
        )}
        initialName={`${worktree.displayName} group`}
        confirmLabel="Create"
        onOpenChange={handleOpenChange}
        onSubmit={handleSubmit}
      />
    )
  }
}
