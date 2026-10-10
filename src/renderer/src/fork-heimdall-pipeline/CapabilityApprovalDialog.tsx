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
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { ApprovalScope } from '../../../shared/fork-heimdall/ledger-types'
import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'

export function CapabilityApprovalDialog({
  open,
  onOpenChange,
  node,
  scope,
  readOnly,
  busy,
  onApprove,
  onAnswered
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  node: PipelineRunNodeView
  scope: ApprovalScope
  readOnly: boolean
  busy: boolean
  onApprove?: (scope: ApprovalScope) => Promise<WatcherCommandResult | null>
  onAnswered?: () => void
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (readOnly || busy || submitting || !onApprove) {
      return
    }
    setSubmitting(true)
    setFeedback(null)
    try {
      const result = await onApprove(scope)
      if (result?.status === 'applied') {
        onOpenChange(false)
        onAnswered?.()
        return
      }
      setFeedback(result === null ? 'The owner did not return an approval result.' : result.detail)
      onAnswered?.()
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pipeline-capability-approval-dialog">
        <DialogHeader>
          <DialogTitle>
            {translate('fork.heimdallPipeline.capabilityApproval.title', 'Approval for {{node}}', {
              node: node.label
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'fork.heimdallPipeline.capabilityApproval.description',
              'Review this exact scoped action before approving it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
          <dt className="text-muted-foreground">
            {translate('fork.heimdallPipeline.capabilityApproval.action', 'Action')}
          </dt>
          <dd className="break-words font-mono">{scope.actionKind}</dd>
          <dt className="text-muted-foreground">
            {translate('fork.heimdallPipeline.capabilityApproval.content', 'Content')}
          </dt>
          <dd className="break-all font-mono">{scope.contentIdentity}</dd>
          <dt className="text-muted-foreground">
            {translate('fork.heimdallPipeline.capabilityApproval.evidence', 'Evidence')}
          </dt>
          <dd className="break-all font-mono">{scope.evidenceKey}</dd>
          {scope.preparedCommitSha ? (
            <>
              <dt className="text-muted-foreground">
                {translate('fork.heimdallPipeline.capabilityApproval.commit', 'Prepared commit')}
              </dt>
              <dd className="break-all font-mono">{scope.preparedCommitSha}</dd>
            </>
          ) : null}
        </dl>
        {feedback ? (
          <p className="text-xs text-status-warning-foreground" role="status">
            {feedback}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('fork.heimdallPipeline.dialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={readOnly || busy || submitting || !onApprove}
            onClick={() => void submit()}
          >
            {submitting
              ? translate('fork.heimdallPipeline.capabilityApproval.approving', 'Approving…')
              : translate('fork.heimdallPipeline.capabilityApproval.approve', 'Approve action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
