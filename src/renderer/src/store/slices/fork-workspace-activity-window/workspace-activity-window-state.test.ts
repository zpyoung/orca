import { describe, expect, it } from 'vitest'
import {
  createWorkspaceActivityWindowSlice,
  type WorkspaceActivityWindowSlice
} from './workspace-activity-window-state'

type SliceSet = Parameters<typeof createWorkspaceActivityWindowSlice>[0]

function createSlice(): { get: () => WorkspaceActivityWindowSlice } {
  let state: WorkspaceActivityWindowSlice
  const set = ((partial: unknown) => {
    const next = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...(next as Partial<WorkspaceActivityWindowSlice>) }
  }) as SliceSet
  state = createWorkspaceActivityWindowSlice(set)
  return { get: () => state }
}

describe('workspace activity window slice', () => {
  it('restores the window the sleeping toggle left', () => {
    const slice = createSlice()
    slice.get().setWorkspaceActivityWindow('week')

    slice.get().setShowSleepingWorkspaces(false)
    expect(slice.get().workspaceActivityWindow).toBe('live-only')

    slice.get().setShowSleepingWorkspaces(true)
    expect(slice.get().workspaceActivityWindow).toBe('week')
    expect(slice.get().showSleepingWorkspaces).toBe(true)
  })

  it('keeps the remembered window across a repeated live-only write', () => {
    const slice = createSlice()
    slice.get().setWorkspaceActivityWindow('month')
    slice.get().setShowSleepingWorkspaces(false)
    slice.get().setWorkspaceActivityWindow('live-only')

    slice.get().setShowSleepingWorkspaces(true)
    expect(slice.get().workspaceActivityWindow).toBe('month')
  })

  it('falls back to all when live-only was never entered through the toggle', () => {
    const slice = createSlice()
    slice.get().setShowSleepingWorkspaces(false)
    slice.get().setShowSleepingWorkspaces(true)
    expect(slice.get().workspaceActivityWindow).toBe('all')
  })

  it('stamps exits monotonically per host-qualified workspace', () => {
    const slice = createSlice()
    slice.get().markWorkspaceActivityExit('workspace', 'ssh:hostA', 200)
    slice.get().markWorkspaceActivityExit('workspace', 'ssh:hostA', 100)
    slice.get().markWorkspaceActivityExit('workspace', 'ssh:hostB', 50)
    slice.get().markWorkspaceActivityExit('unhosted', undefined, 10)

    expect(slice.get().workspaceActivityExitStamps).toEqual({
      'ssh:hostA|workspace': 200,
      'ssh:hostB|workspace': 50,
      unhosted: 10
    })
  })
})
