import { useCallback } from 'react'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { HandoffBriefInputs } from '@/lib/fork-session-handoff/handoff-brief-composer'
import { assembleHandoffBriefForSend } from '@/lib/fork-session-handoff/handoff-brief-composer'
import type { HandoffPreviewPhase } from '@/lib/fork-session-handoff/handoff-preview-detach'
import type { HandoffTargetResolution } from '@/lib/fork-session-handoff/handoff-target-resolution'
import { launchForkSessionHandoff } from '@/lib/fork-session-handoff/launch-session-handoff'
import { useAppStore } from '@/store'
import type { ForkSessionHandoffIncludeToggles } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { ForkHandoffRelationship } from '../../../../../shared/fork-session-handoff/session-lineage-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { clearHandoffDraft, type HandoffDraftSourceIdentity } from './handoff-draft-preservation'
import {
  createAndSelectInlineHandoffTarget,
  handoffCaptureChangedNotice,
  handoffLaunchError,
  persistHandoffPreferencesBestEffort,
  resolveHandoffBodyForStart
} from './handoff-dialog-model'
import { buildHandoffParentIdentity, captureHandoffSource } from './handoff-dialog-source-state'
import { notifyHandoffDelivery } from './handoff-delivery-toast'
import type { ForkSessionHandoffSource } from './prepare-handoff-from-pane'

type UseHandoffDialogStartArgs = {
  request: AgentSessionContinuationRequest | null
  forkSource: ForkSessionHandoffSource | undefined
  selectedAgent: TuiAgent | null
  target: HandoffTargetResolution | null
  compositionInputs: HandoffBriefInputs | null
  previewPhase: HandoffPreviewPhase
  previewBody: string
  previewedBody: string
  startDisabled: boolean
  createMode: boolean
  anchorWorktreeId: string
  createName: string
  createBaseBranch: string
  relationship: ForkHandoffRelationship
  providerSessionId: string | null
  draftIdentity: HandoffDraftSourceIdentity
  includeToggles: ForkSessionHandoffIncludeToggles
  selectedTemplateId: string | null
  launchedRef: { current: boolean }
  setTargetWorktreeId: (worktreeId: string) => void
  setCreateMode: (createMode: boolean) => void
  markTargetChanged: () => void
  setCapturedText: (capturedText: string | null) => void
  setOperationError: (message: string | null) => void
  setStarting: (starting: boolean) => void
}

export function useHandoffDialogStart(args: UseHandoffDialogStartArgs): () => Promise<boolean> {
  return useCallback(async (): Promise<boolean> => {
    if (
      !args.request ||
      !args.selectedAgent ||
      !args.target ||
      !args.compositionInputs ||
      args.startDisabled
    ) {
      return false
    }
    args.setStarting(true)
    args.setOperationError(null)
    let launchTarget: HandoffTargetResolution = args.target
    try {
      if (args.createMode) {
        launchTarget = await createAndSelectInlineHandoffTarget({
          anchorWorktreeId: args.anchorWorktreeId,
          name: args.createName,
          baseBranch: args.createBaseBranch,
          launchSource: args.request.launchSource,
          onCreated: (worktreeId) => {
            args.setTargetWorktreeId(worktreeId)
            args.setCreateMode(false)
            args.markTargetChanged()
          }
        })
      }
      const bodyResolution = resolveHandoffBodyForStart({
        inputs: args.compositionInputs,
        previewPhase: args.previewPhase,
        editedBody: args.previewBody,
        previewedBody: args.previewedBody,
        latestCapture: captureHandoffSource(args.forkSource, args.request.source)
      })
      if (bodyResolution.status === 'capture-changed') {
        args.setCapturedText(bodyResolution.latestCapture)
        args.setOperationError(handoffCaptureChangedNotice())
        return false
      }
      const result = await launchForkSessionHandoff({
        agent: args.selectedAgent,
        briefText: assembleHandoffBriefForSend(bodyResolution.body),
        target: launchTarget,
        groupId: args.request.groupId ?? null,
        launchSource: args.request.launchSource,
        lineage: {
          relationship: args.relationship,
          parent: buildHandoffParentIdentity(
            args.request,
            args.forkSource,
            args.providerSessionId,
            args.compositionInputs.source.transcriptPath ?? null
          )
        }
      })
      if (!result.ok) {
        args.setOperationError(handoffLaunchError(result.reason))
        return false
      }
      args.launchedRef.current = true
      clearHandoffDraft(args.draftIdentity)
      notifyHandoffDelivery(result.tabId, result.deliveryOutcome)
      void persistHandoffPreferencesBestEffort({
        update: (settings) => useAppStore.getState().updateSettings(settings),
        // Why: template bodies are only persisted once the operator configures their own;
        // writing the built-in catalog back would freeze its translated names and pin the
        // defaults against future changes.
        settings: {
          lastAgent: args.selectedAgent,
          includeToggles: args.includeToggles,
          lastTemplateId: args.selectedTemplateId
        }
      })
      return true
    } catch (error) {
      args.setOperationError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      args.setStarting(false)
    }
  }, [args])
}
