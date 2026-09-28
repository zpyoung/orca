import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'
import type { WatcherOwnerConfig } from '../../../shared/fork-heimdall/owner/owner-config'

/** Only `claude` has a resumable, non-PTY structured session Heimdall can wake between turns. */
export const WATCHER_OWNER_SUPPORTED_AGENT = 'claude' as const

export type WatcherOwnerDraft = {
  enabled: boolean
  model: string
  effort: string
}

export function defaultWatcherOwnerDraft(): WatcherOwnerDraft {
  return { enabled: false, model: '', effort: '' }
}

/** `model`/`effort` of `''` mean "let the provider choose" and are omitted from the config. */
export function watcherOwnerFromDraft(draft: WatcherOwnerDraft): WatcherOwnerConfig | undefined {
  if (!draft.enabled) {
    return undefined
  }
  return {
    agent: WATCHER_OWNER_SUPPORTED_AGENT,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.effort ? { effort: draft.effort } : {})
  }
}

/**
 * Kind-specific owner interventions gate on this capability (`OWNER_INTERVENTION_CAPABILITY`).
 * Enabling an owner requests it `'gated'` — every kind-specific move needs approval until the
 * enrollment is explicitly raised to `'on'` — matching this app's default-to-caution convention for
 * new write capabilities (e.g. `land` outside files-on-disk). Leaving the owner off omits the field
 * entirely, so the enrollment's capabilities are byte-for-byte what they'd be without this picker.
 */
export function watcherOwnerInterventionCapability(
  draft: WatcherOwnerDraft
): CapabilityMode | undefined {
  return draft.enabled ? 'gated' : undefined
}
