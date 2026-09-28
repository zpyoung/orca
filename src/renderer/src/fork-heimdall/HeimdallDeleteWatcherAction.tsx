import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  WatcherCommand,
  WatcherCommandResult
} from '../../../shared/fork-heimdall/fleet-types'

type HeimdallDeleteWatcherActionProps = {
  watcherName: string
  disabled: boolean
  deleting: boolean
  onCommand: (key: string, command: WatcherCommand) => Promise<WatcherCommandResult | null>
}

export function HeimdallDeleteWatcherAction({
  watcherName,
  disabled,
  deleting,
  onCommand
}: HeimdallDeleteWatcherActionProps): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const [confirming, setConfirming] = useState(false)

  const requestDelete = async (): Promise<void> => {
    if (disabled || confirming || deleting) {
      return
    }
    setConfirming(true)
    try {
      const accepted = await confirm({
        title: translate('fork.heimdall.controls.deleteTitle', 'Delete watcher?'),
        description: translate(
          'fork.heimdall.controls.deleteDescription',
          'The watcher “{{name}}” and its saved history will be permanently removed. Worker terminals will not be stopped.',
          { name: watcherName }
        ),
        confirmLabel: translate('fork.heimdall.controls.delete', 'Delete watcher'),
        confirmVariant: 'destructive',
        icon: Trash2
      })
      if (accepted) {
        await onCommand('delete', { kind: 'delete' })
      }
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Button
      type="button"
      onClick={requestDelete}
      variant="destructive"
      size="sm"
      disabled={disabled || confirming || deleting}
    >
      {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
      {translate('fork.heimdall.controls.delete', 'Delete watcher')}
    </Button>
  )
}
