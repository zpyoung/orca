import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { cancelLoopClose, resolveLoopCloseChoice, type LoopCloseChoice } from './loop-close-guard'

/** Asks what to do with a running loop when its terminal tab is closed. */
export function LoopCloseDialogHost(): React.JSX.Element | null {
  const confirm = useAppStore((state) => state.loopCloseConfirm)
  const loopName = useAppStore((state) =>
    state.loopCloseConfirm ? state.loopsById[state.loopCloseConfirm.loopId]?.name : undefined
  )
  const [busy, setBusy] = useState(false)

  if (!confirm) {
    return null
  }

  const choose = (choice: LoopCloseChoice): void => {
    setBusy(true)
    void resolveLoopCloseChoice(choice).finally(() => setBusy(false))
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) {
          cancelLoopClose()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('fork.loops.status.close.title', 'Close a running loop?')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'fork.loops.status.close.description',
              'This tab runs the loop "{{name}}". Keep it running in the background, or stop it now.',
              { name: loopName ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => cancelLoopClose()}
          >
            {translate('fork.loops.status.close.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => choose('stop')}
          >
            {translate('fork.loops.status.close.stop', 'Stop loop')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus
            disabled={busy}
            onClick={() => choose('keep-running')}
          >
            {translate('fork.loops.status.close.keepRunning', 'Keep running')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
