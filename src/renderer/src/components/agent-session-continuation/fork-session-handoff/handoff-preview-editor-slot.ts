import type React from 'react'
import {
  reduceHandoffPreview,
  type HandoffPreviewEvent,
  type HandoffPreviewPhase
} from '@/lib/fork-session-handoff/handoff-preview-detach'

// Why: the dialog and its state hook need these, but must not pull Monaco into their static
// graph — TerminalPane imports the dialog, so that would reach every node-environment test.
export const HANDOFF_PREVIEW_EDITOR_SLOT = 'handoff-preview-editor'

/** Find the preview editor's DOM root inside a dialog element, if it is mounted. */
export function getHandoffPreviewEditorRoot(
  dialog: EventTarget | null | undefined
): Element | null {
  return dialog instanceof Element
    ? dialog.querySelector(`[data-slot="${HANDOFF_PREVIEW_EDITOR_SLOT}"]`)
    : null
}

/** Advance the preview detach/attach phase for one editor event. */
export function applyHandoffPreviewEvent(
  event: HandoffPreviewEvent,
  setPhase: React.Dispatch<React.SetStateAction<HandoffPreviewPhase>>
): void {
  setPhase((phase) => reduceHandoffPreview(phase, event).state)
}
