import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import {
  resolveHandoffSourceActivity,
  type HandoffSourceStoreInputs
} from './handoff-dialog-source-state'
import type { ForkSessionHandoffSource } from './prepare-handoff-from-pane'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function source(): ForkSessionHandoffSource {
  return {
    sourcePaneKey: PANE_KEY,
    sourceWorktreeId: 'wt-1',
    anchorWorktreeId: 'wt-1',
    sourceExecutionHostId: 'local',
    providerSessionId: null,
    vaultSessionId: null,
    vaultAgent: null,
    capturePaneScrollback: () => 'capture'
  }
}

function store(livePtyIds: string[]): HandoffSourceStoreInputs {
  return {
    agentStatusEpoch: 1,
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        state: 'working',
        agentType: 'codex',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: [],
        providerSession: { id: 'session-1' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: livePtyIds },
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: OTHER_LEAF_ID },
          ratio: 0.5
        },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-source', [OTHER_LEAF_ID]: 'pty-other' }
      }
    }
  } as unknown as HandoffSourceStoreInputs
}

describe('handoff dialog source state', () => {
  it('does not treat a sibling leaf PTY as source-pane availability', () => {
    expect(resolveHandoffSourceActivity(source(), store(['pty-other']))).toEqual({
      available: false,
      busy: false,
      providerSessionId: 'session-1'
    })
  })

  it('offers busy waiting only when the source leaf PTY is live', () => {
    expect(resolveHandoffSourceActivity(source(), store(['pty-source', 'pty-other']))).toEqual({
      available: true,
      busy: true,
      providerSessionId: 'session-1'
    })
  })
})
