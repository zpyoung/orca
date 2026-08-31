import type { TuiAgent } from '../tui-agent'

export const FORK_SESSION_HANDOFF_LINEAGE_VERSION = 1 as const
export const FORK_SESSION_HANDOFF_LINEAGE_CAP = 500

/** Describes the operator's intent for a one-hop handoff relationship. */
export type ForkHandoffRelationship = 'continues' | 'reviews' | 'branches-from'

/** Identifies one end of a handoff across live panes and archived sessions. */
export type LineageEndpointIdentity = {
  paneKey: string | null
  agent: TuiAgent | null
  providerSessionId: string | null
  transcriptPath: string | null
  worktreeId: string | null
  title: string | null
}

/** Stores one handoff and can be queried from either endpoint. */
export type ForkSessionHandoffLineageRecord = {
  id: string
  createdAt: number
  relationship: ForkHandoffRelationship
  parent: LineageEndpointIdentity
  child: LineageEndpointIdentity & { tabId: string | null }
}

/** Versioned on-disk shape for persisted handoff lineage. */
export type ForkSessionHandoffLineageFile = {
  version: typeof FORK_SESSION_HANDOFF_LINEAGE_VERSION
  records: ForkSessionHandoffLineageRecord[]
}
