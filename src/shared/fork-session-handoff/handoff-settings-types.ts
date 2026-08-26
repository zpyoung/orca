import type { TuiAgent } from '../tui-agent'

/** A reusable operator-authored instruction block for a session handoff. */
export type ForkSessionHandoffTemplate = {
  id: string
  name: string
  body: string
}

/** Controls which optional workspace context Orca adds to a handoff brief. */
export type ForkSessionHandoffIncludeToggles = {
  repoState: boolean
  diffBodies: boolean
  openEditorTabs: boolean
}

/** Global preferences for session handoffs. Context mode intentionally resets per handoff. */
export type ForkSessionHandoffSettings = {
  lastAgent?: TuiAgent
  includeToggles?: ForkSessionHandoffIncludeToggles
  lastTemplateId?: string | null
  templates?: ForkSessionHandoffTemplate[]
}

export const DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES: ForkSessionHandoffIncludeToggles = {
  repoState: true,
  diffBodies: false,
  openEditorTabs: true
}
