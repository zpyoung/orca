import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import {
  INITIAL_HANDOFF_PREVIEW_PHASE,
  type HandoffPreviewPhase
} from '@/lib/fork-session-handoff/handoff-preview-detach'
import { resolveHandoffTarget } from '@/lib/fork-session-handoff/handoff-target-resolution'
import { useAppStore } from '@/store'
import {
  DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
  type ForkSessionHandoffIncludeToggles
} from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { restoreHandoffDraft, type HandoffDraftSourceIdentity } from './handoff-draft-preservation'

/** The per-open starting values for every field the handoff dialog lets the user change. */
export type HandoffDialogOpenSeed = {
  targetWorktreeId: string
  selectedAgent: TuiAgent | null
  includeToggles: ForkSessionHandoffIncludeToggles
  templateId: string | null
  steeringNote: string
  previewPhase: HandoffPreviewPhase
  previewBody: string
}

/**
 * Resolves what a freshly opened handoff dialog should show, preferring a preserved draft over the
 * user's saved preferences and falling back to the source session.
 */
export function buildHandoffDialogOpenSeed({
  draftIdentity,
  anchorWorktreeId,
  request
}: {
  draftIdentity: HandoffDraftSourceIdentity
  anchorWorktreeId: string
  request: AgentSessionContinuationRequest
}): HandoffDialogOpenSeed {
  const restored = restoreHandoffDraft(draftIdentity)
  // Why read through getState: settings.set() returns a freshly deserialized object, so taking
  // preferences as a reactive value would re-seed — and wipe the draft — on any unrelated settings
  // write while the dialog is open.
  const preferences = useAppStore.getState().settings?.forkSessionHandoff
  const detached = restored?.preview.phase === 'detached' ? restored.preview : null

  return {
    targetWorktreeId:
      restored?.targetWorktreeId &&
      resolveHandoffTarget(useAppStore.getState(), restored.targetWorktreeId)
        ? restored.targetWorktreeId
        : anchorWorktreeId,
    selectedAgent:
      restored?.selectedAgent ?? preferences?.lastAgent ?? request.source.sourceAgent ?? null,
    includeToggles:
      restored?.includeToggles ??
      preferences?.includeToggles ??
      DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
    templateId: restored?.templateId ?? preferences?.lastTemplateId ?? null,
    steeringNote: restored?.steeringNote ?? '',
    previewPhase: detached
      ? { phase: 'detached', staleReasons: detached.staleReasons }
      : INITIAL_HANDOFF_PREVIEW_PHASE,
    previewBody: detached ? detached.editedBody : ''
  }
}
