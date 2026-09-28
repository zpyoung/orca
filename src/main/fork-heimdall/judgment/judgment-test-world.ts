import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'

const DEFAULT_CAPABILITIES: NonNullable<ObjectiveWorld['capabilities']> = {
  plan: 'gated',
  implement: 'on',
  review: 'on',
  check: 'on',
  land: 'off'
}

export function world(options: { withCapabilities?: boolean } = {}): ObjectiveWorld {
  return {
    contract: {
      objectiveText: 'Implement the objective',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'folder',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    workspaceKind: 'folder',
    plan: { revisions: [], nodes: [], verdicts: [], landing: [] },
    reports: [],
    budget: { wallClockActiveMs: null, turns: null },
    ...(options.withCapabilities ? { capabilities: DEFAULT_CAPABILITIES } : {}),
    landingContext: {
      branch: null,
      headSha: null,
      worktreeContentDigest: null,
      pushTarget: null,
      hostedReview: null
    }
  }
}

export function ledger(watcherId: string, entries: WatcherLedger['entries']): WatcherLedger {
  return { watcherId, entries }
}
