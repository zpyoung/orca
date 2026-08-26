import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import {
  selectNativeChatRuntimeEnvironmentId,
  selectNativeChatSshConnectionId,
  type NativeChatRuntimeOwnerState,
  type NativeChatSshOwnerState
} from './native-chat-runtime-owner'

function terminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

/** A worktree record with a host id but deliberately no `path` — the owner
 *  selector must not depend on path resolution (KTD-1). */
function worktreeRecord(hostId: string): NativeChatRuntimeOwnerState['worktreesByRepo'] {
  return { repo: [{ id: 'wt-1', repoId: 'repo', hostId } as never] }
}

function state(overrides: Partial<NativeChatRuntimeOwnerState> = {}): NativeChatRuntimeOwnerState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTab()] },
    worktreesByRepo: worktreeRecord('local'),
    ...overrides
  } as NativeChatRuntimeOwnerState
}

describe('selectNativeChatRuntimeEnvironmentId', () => {
  it('returns null for a local-owned worktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state(), 'tab-1')).toBeNull()
  })

  it('returns the decoded environment id for a runtime-owned worktree', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })

  it('returns null for an ssh-connection worktree (Model A stays local)', () => {
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('ssh:conn-1') }),
        'tab-1'
      )
    ).toBeNull()
  })

  it('returns null when the terminal tab matches no tab in tabsByWorktree', () => {
    expect(selectNativeChatRuntimeEnvironmentId(state({ tabsByWorktree: {} }), 'tab-1')).toBeNull()
  })

  it('returns the owner id even when the worktree record has no resolvable path', () => {
    // Guards KTD-1: no `path` on the worktree record and no getKnownWorktreeById —
    // the selector must still resolve the runtime owner from the host mapping alone.
    expect(
      selectNativeChatRuntimeEnvironmentId(
        state({ worktreesByRepo: worktreeRecord('runtime:env-1') }),
        'tab-1'
      )
    ).toBe('env-1')
  })
})

/** A repo carrying the ssh connection that owns its worktrees. */
function sshState(connectionId: string | null): NativeChatSshOwnerState {
  return {
    ...state(),
    repos: [{ id: 'repo', connectionId } as never],
    worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo', hostId: 'local' } as never] }
  } as unknown as NativeChatSshOwnerState
}

describe('selectNativeChatSshConnectionId', () => {
  it('returns null for a local worktree', () => {
    expect(selectNativeChatSshConnectionId(sshState(null), 'tab-1')).toBeNull()
  })

  it('returns the connection id for a plain ssh worktree', () => {
    expect(selectNativeChatSshConnectionId(sshState('ssh-target-1'), 'tab-1')).toBe('ssh-target-1')
  })

  // Runtime-owned ssh targets are Model B: they already read over runtime RPC,
  // so routing them at the relay too would double-own the transcript.
  it('returns null for a runtime-owned ssh target', () => {
    expect(selectNativeChatSshConnectionId(sshState('runtime-ssh-env-1'), 'tab-1')).toBeNull()
  })

  it('returns null when the worktree is runtime-owned', () => {
    const runtimeOwned = {
      ...sshState('ssh-target-1'),
      worktreesByRepo: worktreeRecord('runtime:env-1')
    } as unknown as NativeChatSshOwnerState
    expect(selectNativeChatSshConnectionId(runtimeOwned, 'tab-1')).toBeNull()
  })

  it('returns null when the tab matches no worktree', () => {
    expect(selectNativeChatSshConnectionId(sshState('ssh-target-1'), 'tab-missing')).toBeNull()
  })
})
