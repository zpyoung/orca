import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { ApprovalScope } from '../../../shared/fork-heimdall/ledger-types'
import type {
  WatcherCommand,
  WatcherCommandResult
} from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { PIPELINE_NODE_TYPES } from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  parsePipelineNodeEvidenceKey,
  pipelineChoiceOptions,
  type PipelineChoice
} from '../../../shared/fork-heimdall-pipeline/choice-types'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { formatHeimdallTime } from '../fork-heimdall/fleet-format'

export type PipelineChoiceCommand = Extract<WatcherCommand, { kind: 'answer-pipeline-choice' }>
const CHOICE_COPY: Record<PipelineChoice, { key: string; fallback: string }> = {
  approve: {
    key: 'fork.heimdallPipeline.gateDialog.choices.approve',
    fallback: 'Approve'
  },
  'send-back': {
    key: 'fork.heimdallPipeline.gateDialog.choices.sendBack',
    fallback: 'Send back'
  },
  abort: { key: 'fork.heimdallPipeline.gateDialog.choices.abort', fallback: 'Abort' },
  retry: { key: 'fork.heimdallPipeline.gateDialog.choices.retry', fallback: 'Retry' },
  skip: { key: 'fork.heimdallPipeline.gateDialog.choices.skip', fallback: 'Skip' },
  extend: { key: 'fork.heimdallPipeline.gateDialog.choices.extend', fallback: 'Extend' },
  accept: { key: 'fork.heimdallPipeline.gateDialog.choices.accept', fallback: 'Accept as is' },
  'one-more-round': {
    key: 'fork.heimdallPipeline.gateDialog.choices.oneMoreRound',
    fallback: 'One more round'
  }
}
export function pipelineChoiceLabel(choice: PipelineChoice): string {
  const copy = CHOICE_COPY[choice]
  return translate(copy.key, copy.fallback)
}

export function pipelineChoicesForNode(
  view: PipelineRunView,
  node: PipelineRunNodeView,
  scope: ApprovalScope
): readonly PipelineChoice[] {
  if (
    (scope.actionKind !== 'pipeline-pass-gate' && scope.actionKind !== 'pipeline-apply-choice') ||
    !PIPELINE_NODE_TYPES.some((type) => type === node.type)
  ) {
    return []
  }
  const identity = parsePipelineNodeEvidenceKey(scope.evidenceKey)
  if (
    !identity ||
    identity.instanceId !== node.instanceId ||
    identity.epoch !== node.epoch ||
    identity.attempt !== node.attempt ||
    identity.cause === undefined ||
    (scope.actionKind === 'pipeline-pass-gate' && identity.cause !== 'gate') ||
    (scope.actionKind === 'pipeline-apply-choice' && identity.cause === 'gate')
  ) {
    return []
  }
  const documentNode = view.document.nodes.find((candidate) => candidate.id === node.nodeId)
  if (!documentNode) {
    return []
  }
  const sendBackTo =
    documentNode.type === 'gate' &&
    'sendBackTo' in documentNode &&
    typeof documentNode.sendBackTo === 'string'
      ? documentNode.sendBackTo
      : undefined
  const onFailValue = 'onFail' in documentNode ? documentNode.onFail : undefined
  const onFailSendBackTo =
    onFailValue !== null &&
    typeof onFailValue === 'object' &&
    !Array.isArray(onFailValue) &&
    'sendBackTo' in onFailValue &&
    typeof onFailValue.sendBackTo === 'string'
      ? onFailValue.sendBackTo
      : undefined
  return pipelineChoiceOptions({
    nodeType: node.type,
    cause: identity.cause,
    ...(sendBackTo === undefined ? {} : { gateSendBackTo: sendBackTo }),
    ...(onFailSendBackTo === undefined ? {} : { onFailSendBackTo })
  })
}

function refusalDetail(result: WatcherCommandResult): string | null {
  if (result.status === 'applied') {
    return null
  }
  if (result.status === 'refused' && result.reason === 'already-resolved' && result.resolvedBy) {
    return translate(
      'fork.heimdallPipeline.gateDialog.alreadyAnswered',
      'Already answered by {{user}}@{{host}} from {{surface}} at {{time}}',
      {
        user: result.resolvedBy.actor.user,
        host: result.resolvedBy.actor.host,
        surface: result.resolvedBy.surface,
        time: formatHeimdallTime(result.resolvedBy.atMs)
      }
    )
  }
  return result.detail
}

type PipelineGateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  view: PipelineRunView
  node: PipelineRunNodeView
  scope: ApprovalScope
  row: WatcherFleetEntryReader
  readOnly: boolean
  busy: boolean
  surface: 'heimdall-detail' | 'canvas-run'
  onAnswer: (command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>
  onAnswered?: () => void
  initialChoice?: PipelineChoice
}

export function PipelineGateDialog(props: PipelineGateDialogProps): React.JSX.Element {
  const sessionKey = JSON.stringify([
    props.initialChoice ?? null,
    props.node.instanceId,
    props.open,
    props.scope.evidenceKey
  ])
  return <PipelineGateDialogSession key={sessionKey} {...props} />
}

function PipelineGateDialogSession({
  open,
  onOpenChange,
  view,
  node,
  scope,
  row,
  readOnly,
  busy,
  surface,
  onAnswer,
  onAnswered,
  initialChoice
}: PipelineGateDialogProps): React.JSX.Element {
  const options = useMemo(() => pipelineChoicesForNode(view, node, scope), [node, scope, view])
  const displayedOptions =
    initialChoice === undefined ? options : options.includes(initialChoice) ? [initialChoice] : []
  const [comment, setComment] = useState('')
  const [extendMinutes, setExtendMinutes] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canAnswer =
    !readOnly &&
    row.entry.enrollment.kind !== 'unknown' &&
    view.kind !== 'unknown' &&
    displayedOptions.length > 0
  const parsedMinutes = Number(extendMinutes)
  const extendMinutesInvalid =
    !/^[1-9]\d*$/u.test(extendMinutes) || parsedMinutes < 1 || parsedMinutes > 1_440

  const submit = async (choice: PipelineChoice): Promise<void> => {
    if (
      !canAnswer ||
      busy ||
      submitting ||
      (choice === 'send-back' && comment.trim().length === 0) ||
      (choice === 'extend' && extendMinutesInvalid)
    ) {
      return
    }
    setSubmitting(true)
    setFeedback(null)
    const command: PipelineChoiceCommand = {
      kind: 'answer-pipeline-choice',
      scope,
      choice,
      surface,
      ...(choice === 'send-back' ? { comment: comment.trim() } : {}),
      ...(choice === 'extend' ? { extendMinutes: parsedMinutes } : {})
    }
    try {
      const result = await onAnswer(command)
      if (result === null) {
        setFeedback(
          translate(
            'fork.heimdallPipeline.gateDialog.error',
            'Unable to submit the choice: {{error}}',
            { error: 'The owner did not return a result.' }
          )
        )
        return
      }
      const detail = refusalDetail(result)
      if (detail !== null) {
        setFeedback(detail)
        onAnswered?.()
        return
      }
      onOpenChange(false)
      onAnswered?.()
    } catch (cause) {
      setFeedback(
        translate(
          'fork.heimdallPipeline.gateDialog.error',
          'Unable to submit the choice: {{error}}',
          { error: cause instanceof Error ? cause.message : String(cause) }
        )
      )
    } finally {
      setSubmitting(false)
    }
  }

  const commentId = `pipeline-gate-comment-${node.instanceId}`
  const minutesId = `pipeline-extend-minutes-${node.instanceId}`
  const disabled = !canAnswer || readOnly || busy || submitting
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="pipeline-gate-dialog">
        <DialogHeader>
          <DialogTitle>
            {translate('fork.heimdallPipeline.gateDialog.title', 'Decision for {{node}}', {
              node: node.label
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'fork.heimdallPipeline.gateDialog.description',
              'Choose how this pipeline run continues.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {displayedOptions.includes('send-back') ? (
            <div className="space-y-1">
              <Label htmlFor={commentId}>
                {translate('fork.heimdallPipeline.gateDialog.comment', 'Comment')}
              </Label>
              <Input
                id={commentId}
                data-testid="pipeline-gate-comment"
                value={comment}
                maxLength={4_000}
                disabled={disabled}
                onChange={(event) => setComment(event.currentTarget.value)}
              />
            </div>
          ) : null}
          {displayedOptions.includes('extend') ? (
            <div className="space-y-1">
              <Label htmlFor={minutesId}>
                {translate('fork.heimdallPipeline.gateDialog.extendMinutes', 'Minutes to extend')}
              </Label>
              <Input
                id={minutesId}
                data-testid="pipeline-extend-minutes"
                type="number"
                min="1"
                max="1440"
                step="1"
                value={extendMinutes}
                disabled={disabled}
                onChange={(event) => setExtendMinutes(event.currentTarget.value)}
              />
              {extendMinutesInvalid ? (
                <p className="text-xs text-muted-foreground" role="status">
                  {translate(
                    'fork.heimdallPipeline.gateDialog.minutesRequired',
                    'Enter an extension from 1 to 1440 minutes.'
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          {displayedOptions.includes('send-back') && comment.trim().length === 0 ? (
            <p className="text-xs text-muted-foreground" role="status">
              {translate(
                'fork.heimdallPipeline.gateDialog.commentRequired',
                'A comment is required to send back.'
              )}
            </p>
          ) : null}
          {feedback ? (
            <p className="text-xs text-destructive" role="alert">
              {feedback}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {displayedOptions.map((choice) => (
            <Button
              key={choice}
              type="button"
              data-testid={`pipeline-choice-${choice}`}
              variant={
                choice === 'abort' ? 'destructive' : choice === 'approve' ? 'default' : 'outline'
              }
              disabled={
                disabled ||
                (choice === 'send-back' && comment.trim().length === 0) ||
                (choice === 'extend' && extendMinutesInvalid)
              }
              onClick={() => void submit(choice)}
            >
              {submitting && choice === 'approve'
                ? translate('fork.heimdallPipeline.gateDialog.submitting', 'Submitting answer…')
                : pipelineChoiceLabel(choice)}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
