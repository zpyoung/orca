import React, { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { LedgerRemovalPreview } from '../../../../shared/ledger'
import { requestLedger } from '@/runtime/runtime-ledger-client'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  retentionChecking,
  retentionNone,
  retentionSummary,
  retentionTitle
} from '../ledger/ledger-retention-notice-copy'

// Why: interpolated into the sentence so locales control where the name sits;
// U+0000 cannot appear in a real project name, so the split is unambiguous.
const NAME_TOKEN = '\u0000'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)
  const [ledgerPreview, setLedgerPreview] = useState<LedgerRemovalPreview[]>([])
  const [ledgerPreviewLoading, setLedgerPreviewLoading] = useState(false)
  const [ledgerPreviewError, setLedgerPreviewError] = useState<string | null>(null)
  const [ledgerPreviewGeneration, setLedgerPreviewGeneration] = useState(0)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const hostId = typeof modalData.hostId === 'string' ? (modalData.hostId as ExecutionHostId) : null
  const repo = useAppStore((s) =>
    s.repos.find(
      (candidate) =>
        candidate.id === repoId && (!hostId || getRepoExecutionHostId(candidate) === hostId)
    )
  )

  // Why: for an SSH project the files live on the remote host's disk, not the
  // user's — "still on your disk" would be misleading. Name the host (using the
  // removed-target label when it's a ghost) so the user knows where it remains
  // and that re-adding that host recovers it.
  const sshConnectionId = useAppStore(
    (s) =>
      s.repos
        .find((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
        ?.connectionId?.trim() ?? null
  )
  const sshHostLabel = useAppStore((s) => {
    if (!sshConnectionId) {
      return null
    }
    return (
      s.sshTargetLabels.get(sshConnectionId) ??
      s.removedSshTargetLabels.get(sshConnectionId) ??
      sshConnectionId
    )
  })

  // Why: fragment concatenation around the styled name cannot be reordered by
  // SOV locales (#9294). Translate one full sentence with the name as a
  // sentinel token, then split on it to re-apply the inline emphasis.
  const description = isRuntimeOwnedSshTargetId(sshConnectionId)
    ? translate(
        'auto.components.sidebar.RemoveFolderDialog.removeDescriptionVmRecipe',
        'This removes {{name}} from Orca. Its VM recipe determines whether the environment and its files are permanently deleted.',
        { name: NAME_TOKEN }
      )
    : sshHostLabel
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionSsh',
          'This only removes {{name}} from Orca. Its files stay on {{host}} — re-add that SSH host to recover it.',
          { name: NAME_TOKEN, host: sshHostLabel }
        )
      : translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionLocal',
          'This only removes {{name}} from Orca. It is still on your disk.',
          { name: NAME_TOKEN }
        )
  const [descriptionBeforeName, descriptionAfterName] = description.split(NAME_TOKEN)

  useEffect(() => {
    if (!isOpen || !repoId) {
      return
    }
    let cancelled = false
    setLedgerPreviewLoading(true)
    setLedgerPreviewError(null)
    const parsedHost = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
    void requestLedger(
      { operation: 'removal-preview', removal: { repoId } },
      parsedHost?.kind === 'runtime' ? parsedHost.environmentId : undefined
    )
      .then((response) => {
        if (cancelled) {
          return
        }
        setLedgerPreview(response.removalPreview ?? [])
        setLedgerPreviewLoading(false)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        setLedgerPreviewLoading(false)
        setLedgerPreviewError(error instanceof Error ? error.message : 'Ledger preview unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, repoId, repo, ledgerPreviewGeneration])

  const handleConfirm = useCallback(async () => {
    if (repoId) {
      try {
        await removeProject(repoId, {
          ...(hostId ? { hostId } : {}),
          errorFeedback: 'toast',
          expectedLedgers: ledgerPreview.map(({ ledgerId, revision }) => ({ ledgerId, revision }))
        })
      } catch (error) {
        const code = (error as { code?: string })?.code
        if (code === 'conflict' || (error instanceof Error && error.message.includes('conflict'))) {
          setLedgerPreview([])
          setLedgerPreviewError(null)
          setLedgerPreviewLoading(true)
          setLedgerPreviewGeneration((generation) => generation + 1)
          return
        }
        throw error
      }
      closeModal()
    }
  }, [closeModal, hostId, ledgerPreview, removeProject, repoId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {descriptionBeforeName}
            <span className="break-all font-medium text-foreground">{displayName}</span>
            {descriptionAfterName}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
          <div className="font-medium text-foreground">{retentionTitle()}</div>
          {ledgerPreviewLoading ? (
            <div className="mt-1 text-muted-foreground">{retentionChecking()}</div>
          ) : ledgerPreviewError ? (
            <div className="mt-1 text-destructive" role="alert">
              {ledgerPreviewError}
            </div>
          ) : ledgerPreview.length === 0 ? (
            <div className="mt-1 text-muted-foreground">{retentionNone()}</div>
          ) : (
            <div className="mt-1 text-muted-foreground">
              {retentionSummary(
                ledgerPreview.reduce((total, ledger) => total + ledger.entryCount, 0),
                ledgerPreview.length
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.RemoveFolderDialog.d36883e046', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={ledgerPreviewLoading || Boolean(ledgerPreviewError)}
            onClick={() => void handleConfirm()}
          >
            {translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
