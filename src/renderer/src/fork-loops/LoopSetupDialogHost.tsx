import { TooltipProvider } from '@/components/ui/tooltip'
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
    // why: App mounts this host outside its TooltipProvider, and the dialog renders tooltips
    <TooltipProvider delayDuration={400}>
      <LoopSetupDialog
        open
        worktreeId={worktreeId}
        onOpenChange={(open) => {
          if (!open) {
            closeLoopSetup()
          }
        }}
      />
    </TooltipProvider>
  )
}
