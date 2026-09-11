import type { LedgerEntry, LedgerRequest } from '../../../../shared/ledger'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export type LedgerConfirmation = {
  message: string
  request: LedgerRequest
  entries: LedgerEntry[]
  error?: string
  blocked?: boolean
}

type LedgerConfirmationDialogProps = {
  confirmation: LedgerConfirmation | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

export function LedgerConfirmationDialog({
  confirmation,
  pending,
  onOpenChange,
  onConfirm
}: LedgerConfirmationDialogProps): React.JSX.Element {
  return (
    <Dialog open={Boolean(confirmation)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm ledger action</DialogTitle>
        </DialogHeader>
        <p className="text-sm">{confirmation?.message}</p>
        {confirmation?.entries.map((entry) => (
          <p key={entry.id} className="text-sm">
            {entry.id} · revision {entry.revision} · {String(entry.content.title)}
          </p>
        ))}
        {confirmation?.request.ifLedgerRevision !== undefined ? (
          <p className="text-xs text-muted-foreground">
            Ledger revision {confirmation.request.ifLedgerRevision}
          </p>
        ) : null}
        {confirmation?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {confirmation.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={
              confirmation?.request.operation.startsWith('delete') ? 'destructive' : 'default'
            }
            disabled={pending || confirmation?.blocked}
            onClick={onConfirm}
          >
            Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
