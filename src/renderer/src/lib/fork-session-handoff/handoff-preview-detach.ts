export type DetachStaleReason =
  | 'controls-changed'
  | 'target-changed'
  | 'newer-session-context'
  | 'rescan-completed'

export type HandoffPreviewPhase =
  | { phase: 'attached' }
  | { phase: 'detached'; staleReasons: DetachStaleReason[] }

export type HandoffPreviewEvent =
  | { type: 'user-edit' }
  | { type: 'regenerate' }
  | { type: 'controls-changed' }
  | { type: 'target-changed' }
  | { type: 'observed-idle' }
  | { type: 'rescan-completed' }

export type HandoffPreviewEffect = 'recompose' | 'notice' | 'none'

export type HandoffPreviewTransition = {
  state: HandoffPreviewPhase
  effect: HandoffPreviewEffect
}

export const INITIAL_HANDOFF_PREVIEW_PHASE: HandoffPreviewPhase = { phase: 'attached' }

/** Applies detach precedence so automatic updates never overwrite a manual edit. */
export function reduceHandoffPreview(
  state: HandoffPreviewPhase,
  event: HandoffPreviewEvent
): HandoffPreviewTransition {
  if (event.type === 'user-edit') {
    return state.phase === 'detached'
      ? { state, effect: 'none' }
      : { state: { phase: 'detached', staleReasons: [] }, effect: 'none' }
  }

  if (event.type === 'regenerate') {
    return { state: { phase: 'attached' }, effect: 'recompose' }
  }

  if (state.phase === 'attached') {
    return reduceAttachedPreview(state, event)
  }

  return reduceDetachedPreview(state, event)
}

function reduceAttachedPreview(
  state: HandoffPreviewPhase & { phase: 'attached' },
  event: Exclude<HandoffPreviewEvent, { type: 'user-edit' | 'regenerate' }>
): HandoffPreviewTransition {
  if (event.type === 'rescan-completed') {
    return { state, effect: 'none' }
  }
  return { state, effect: 'recompose' }
}

function reduceDetachedPreview(
  state: HandoffPreviewPhase & { phase: 'detached' },
  event: Exclude<HandoffPreviewEvent, { type: 'user-edit' | 'regenerate' }>
): HandoffPreviewTransition {
  const reason = staleReasonFor(event.type)
  const staleReasons = state.staleReasons.includes(reason)
    ? state.staleReasons
    : [...state.staleReasons, reason]
  return {
    state: staleReasons === state.staleReasons ? state : { phase: 'detached', staleReasons },
    effect: 'notice'
  }
}

function staleReasonFor(
  eventType: Exclude<HandoffPreviewEvent['type'], 'user-edit' | 'regenerate'>
): DetachStaleReason {
  switch (eventType) {
    case 'controls-changed':
      return 'controls-changed'
    case 'target-changed':
      return 'target-changed'
    case 'observed-idle':
      return 'newer-session-context'
    case 'rescan-completed':
      return 'rescan-completed'
  }
}
