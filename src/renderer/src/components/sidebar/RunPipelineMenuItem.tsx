import { useState } from 'react'
import { Route } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import PipelineStartDialog from '@/components/pipeline-canvas/PipelineStartDialog'
import { ensurePipelineTab } from '@/lib/ensure-pipeline-tab'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

/** Sidebar workspace-context-menu entry point for the pipeline-run feature. */
export function RunPipelineMenuItem({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  const target: RuntimeClientTarget = environmentId
    ? { kind: 'environment', environmentId }
    : { kind: 'local' }
  const isFolderWorkspace = parseWorkspaceKey(worktreeId)?.type === 'folder'

  return (
    <>
      <DropdownMenuItem
        disabled={disabled}
        onSelect={(event) => {
          // why: keep the menu mounted so this component's own dialog-open state
          // survives — a select normally closes and unmounts DropdownMenuContent.
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Route className="size-3.5" />
        {translate('auto.components.sidebar.RunPipelineMenuItem.run', 'Run pipeline…')}
      </DropdownMenuItem>
      <PipelineStartDialog
        open={open}
        onOpenChange={setOpen}
        worktreeSelector={toRuntimeWorktreeSelector(worktreeId)}
        workspaceId={worktreeId}
        target={target}
        isFolderWorkspace={isFolderWorkspace}
        hasSubmodules={false}
        onStarted={(result) => {
          ensurePipelineTab(worktreeId, {
            runId: result.runId,
            runNumber: result.runNumber,
            templateName: result.templateName
          })
        }}
      />
    </>
  )
}
