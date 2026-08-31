import { useRef } from 'react'
import { Loader2, MessageSquarePlus } from 'lucide-react'
import { closeUnfocusedMonacoFindOrPreventDialogDismiss } from '@/components/editor/monaco-find-widget'
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
import { getAgentLabel } from '@/lib/agent-catalog'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { HandoffContentControls } from './HandoffContentControls'
import { HandoffDestinationControls } from './HandoffDestinationControls'
import { HandoffNotesControls } from './HandoffNotesControls'
import { HandoffPreviewColumn } from './HandoffPreviewColumn'
import { getHandoffPreviewEditorRoot } from './handoff-preview-editor-slot'
import { HandoffWarningsBanner } from './HandoffWarningsBanner'
import type { ForkSessionHandoffRequest } from './prepare-handoff-from-pane'
import { useHandoffDialogState } from './use-handoff-dialog-state'

type AgentSessionContinuationDialogProps = {
  open: boolean
  request: AgentSessionContinuationRequest | null
  onOpenChange: (open: boolean) => void
}

export function AgentSessionContinuationDialog({
  open,
  request,
  onOpenChange
}: AgentSessionContinuationDialogProps): React.JSX.Element {
  const state = useHandoffDialogState({ open, request })
  const contentRef = useRef<HTMLDivElement>(null)
  const forkSource = (request as ForkSessionHandoffRequest | null)?.forkSource

  const dismiss = (): void => {
    if (state.starting) {
      return
    }
    state.dismiss()
    onOpenChange(false)
  }
  const start = async (): Promise<void> => {
    if (await state.start()) {
      onOpenChange(false)
    }
  }
  const sourceName = request?.source.sourceTitle?.trim()
  const sourceAgentLabel = request?.source.sourceAgent
    ? getAgentLabel(request.source.sourceAgent)
    : null

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          dismiss()
        }
      }}
    >
      <DialogContent
        ref={contentRef}
        className="flex h-[min(900px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1120px]"
        onEscapeKeyDown={(event) => {
          if (
            closeUnfocusedMonacoFindOrPreventDialogDismiss({
              root: getHandoffPreviewEditorRoot(contentRef.current),
              eventTarget: event.target
            })
          ) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MessageSquarePlus className="size-4" aria-hidden="true" />
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.dialogTitle',
              'Continue in New Session'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.dialogDescription',
              'Review and customize the brief, destination, and delivery for a fresh Agent session. The source stays running.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(18rem,0.8fr)_minmax(24rem,1.2fr)]">
          <div className="scrollbar-sleek min-h-0 min-w-0 space-y-5 overflow-y-auto border-b border-border p-4 md:border-r md:border-b-0">
            <section className="min-w-0 rounded-md border border-border bg-muted/30 px-3 py-2">
              <div className="truncate text-xs font-medium">
                {sourceName ||
                  translate(
                    'components.agentSessionContinuation.forkSessionHandoff.untitledSession',
                    'Current session'
                  )}
              </div>
              {sourceAgentLabel ? (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {translate(
                    'components.agentSessionContinuation.forkSessionHandoff.originalAgent',
                    'Original Agent: {{agent}}',
                    { agent: sourceAgentLabel }
                  )}
                </div>
              ) : null}
              {!forkSource?.sourcePaneKey ? (
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  {translate(
                    'components.agentSessionContinuation.forkSessionHandoff.noLivePane',
                    'This source has no live pane. Idle waiting and live scrollback recapture are unavailable.'
                  )}
                </p>
              ) : null}
            </section>

            <HandoffDestinationControls
              disabled={state.previewDetached}
              targets={state.targets}
              targetWorktreeId={state.targetWorktreeId}
              targetPath={state.targetPath}
              onTargetChange={state.selectTarget}
              createMode={state.createMode}
              canCreateWorktree={state.canCreateWorktree}
              createName={state.createName}
              createBaseBranch={state.createBaseBranch}
              onCreateModeChange={state.setCreateMode}
              onCreateNameChange={state.setCreateName}
              onCreateBaseBranchChange={state.setCreateBaseBranch}
              relationship={state.relationship}
              onRelationshipChange={state.setRelationship}
              agents={state.agents}
              selectedAgent={state.selectedAgent}
              onAgentChange={state.selectAgent}
              detectingAgents={state.detectingAgents}
              agentDetectionFailed={state.agentDetectionFailed}
            />
            <HandoffContentControls
              disabled={state.previewDetached}
              contextMode={state.contextMode}
              onContextModeChange={state.setContextMode}
              contextControlDisabled={state.contextControlDisabled}
              contextDisabledReason={state.contextDisabledReason}
              includeToggles={state.includeToggles}
              onIncludeTogglesChange={state.setIncludeToggles}
              repoStateLoading={state.repoStateLoading}
            />
            <HandoffNotesControls
              disabled={state.previewDetached}
              templates={state.templates}
              selectedTemplateId={state.selectedTemplateId}
              steeringNote={state.steeringNote}
              onTemplateChange={state.setSelectedTemplateId}
              onSteeringNoteChange={state.setSteeringNote}
              onSaveSteeringNoteAsTemplate={state.saveSteeringNoteAsTemplate}
            />
          </div>

          <HandoffPreviewColumn
            value={state.previewBody}
            safetyBlock={state.safetyBlock}
            charCount={state.charCount}
            tokenEstimate={state.tokenEstimate}
            secretHits={state.secretHits}
            detached={state.previewDetached}
            onChange={state.editPreview}
            onRegenerate={state.regeneratePreview}
            onDismiss={dismiss}
          />
        </div>

        <div className="shrink-0 border-t border-border px-4 pt-3">
          <HandoffWarningsBanner
            warnings={state.warnings}
            waitingForIdle={state.waitingForIdle}
            onWaitForIdle={state.waitForIdle}
            onCaptureAnyway={state.captureAnyway}
          />
        </div>
        <DialogFooter className="shrink-0 px-4 py-3">
          <Button type="button" variant="ghost" disabled={state.starting} onClick={dismiss}>
            {translate('components.native-chat.question.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            autoFocus
            disabled={state.startDisabled}
            onClick={() => void start()}
          >
            {state.starting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {state.starting
              ? translate(
                  'components.agentSessionContinuation.forkSessionHandoff.starting',
                  'Starting…'
                )
              : translate(
                  'components.agentSessionContinuation.forkSessionHandoff.startSession',
                  'Start New Session'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
