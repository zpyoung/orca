import { useAppStore } from '@/store'
import { LoopSetupDialog } from './LoopSetupDialog'

/** Mounts the setup dialog once at the app root; the + menu opens it through the loops slice. */
export function LoopSetupDialogHost(): React.JSX.Element | null {
  const dialog = useAppStore((s) => s.loopSetupDialog)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const closeLoopSetup = useAppStore((s) => s.closeLoopSetup)
  const worktreeId = dialog.worktreeId ?? activeWorktreeId
  if (!dialog.open || !worktreeId) {
    return null
  }
  return (
    <LoopSetupDialog
      open
      worktreeId={worktreeId}
      onOpenChange={(open) => {
        if (!open) {
          closeLoopSetup()
        }
      }}
    />
  )
}
