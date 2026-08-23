import type { PaneFocusOwnership } from '../pane-helpers'

/** Yields no argument at all when the dock is off, so the call keeps upstream's
 *  single-argument shape rather than passing an ownership that owns nothing. */
export function paneFocusOwnershipArgs(
  tabId: string,
  paneDockOwnsFocus: PaneFocusOwnership['paneDockOwnsFocus'] | undefined
): [] | [PaneFocusOwnership] {
  return paneDockOwnsFocus ? [{ tabId, paneDockOwnsFocus }] : []
}
