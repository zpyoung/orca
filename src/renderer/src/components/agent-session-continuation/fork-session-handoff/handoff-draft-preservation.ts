import type { ForkSessionHandoffIncludeToggles } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { DetachStaleReason } from '@/lib/fork-session-handoff/handoff-preview-detach'

export type HandoffDraftSourceIdentity = {
  sourcePaneKey: string | null
  vaultAgent: TuiAgent | null
  vaultSessionId: string | null
}

export type PreservedHandoffDraft = {
  steeringNote: string
  includeToggles: ForkSessionHandoffIncludeToggles
  templateId: string | null
  selectedAgent: TuiAgent | null
  targetWorktreeId: string
  preview:
    | { phase: 'attached' }
    | { phase: 'detached'; editedBody: string; staleReasons: DetachStaleReason[] }
}

const draftsBySource = new Map<string, PreservedHandoffDraft>()

/** Return the stable in-memory key used to preserve a source session's draft. */
export function getHandoffDraftSourceKey(source: HandoffDraftSourceIdentity): string | null {
  if (source.sourcePaneKey) {
    return source.sourcePaneKey
  }
  if (source.vaultAgent && source.vaultSessionId) {
    return `vault:${source.vaultAgent}:${source.vaultSessionId}`
  }
  return null
}

/** Store a snapshot of a handoff draft for one source session. */
export function preserveHandoffDraft(
  source: HandoffDraftSourceIdentity,
  draft: PreservedHandoffDraft
): boolean {
  const key = getHandoffDraftSourceKey(source)
  if (!key) {
    return false
  }
  draftsBySource.set(key, cloneDraft(draft))
  return true
}

/** Return an isolated snapshot of the draft saved for a source session. */
export function restoreHandoffDraft(
  source: HandoffDraftSourceIdentity
): PreservedHandoffDraft | null {
  const key = getHandoffDraftSourceKey(source)
  const draft = key ? draftsBySource.get(key) : undefined
  return draft ? cloneDraft(draft) : null
}

/** Clear the draft saved for one source session. */
export function clearHandoffDraft(source: HandoffDraftSourceIdentity): boolean {
  const key = getHandoffDraftSourceKey(source)
  return key ? draftsBySource.delete(key) : false
}

function cloneDraft(draft: PreservedHandoffDraft): PreservedHandoffDraft {
  return {
    ...draft,
    includeToggles: { ...draft.includeToggles },
    preview:
      draft.preview.phase === 'attached'
        ? { phase: 'attached' }
        : {
            phase: 'detached',
            editedBody: draft.preview.editedBody,
            staleReasons: [...draft.preview.staleReasons]
          }
  }
}
