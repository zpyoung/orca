import type { StateCreator } from 'zustand'
import { translate } from '@/i18n/i18n'
import type {
  HeimdallFleetSnapshot,
  WatcherTarget
} from '../../../../../shared/fork-heimdall/fleet-types'
import type { UiViewHistory } from '../ui/ui-slice-contract-core'
import { rewindHistoryIndexPastView } from '../worktree-nav-history'
import type { AppState } from '../../types'

export type HeimdallFleetSlice = {
  heimdallFleet: HeimdallFleetSnapshot | null
  heimdallFleetLoading: boolean
  heimdallFleetError: string | null
  heimdallFleetGeneration: number
  heimdallSelectedTarget: WatcherTarget | null
  previousViewBeforeHeimdall: Exclude<UiViewHistory, 'heimdall'>
  hydrateHeimdallFleet: () => Promise<void>
  applyHeimdallFleetSnapshot: (snapshot: HeimdallFleetSnapshot) => void
  selectHeimdallWatcher: (target: WatcherTarget | null) => void
  openHeimdallPage: () => void
  closeHeimdallPage: () => void
}

function sameTarget(left: WatcherTarget, right: WatcherTarget): boolean {
  return (
    left.watcherId === right.watcherId &&
    left.connectionId === right.connectionId &&
    left.pairingRevision === right.pairingRevision
  )
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error)
}

export const createHeimdallFleetSlice: StateCreator<AppState, [], [], HeimdallFleetSlice> = (
  set,
  get
) => ({
  heimdallFleet: null,
  heimdallFleetLoading: false,
  heimdallFleetError: null,
  heimdallFleetGeneration: 0,
  heimdallSelectedTarget: null,
  previousViewBeforeHeimdall: 'terminal',
  hydrateHeimdallFleet: async () => {
    const api = window.api?.heimdall
    if (!api || typeof api.fleet !== 'function') {
      set({
        heimdallFleetLoading: false,
        heimdallFleetError: translate(
          'fork.heimdall.error.unavailable',
          'Heimdall control plane is unavailable.'
        )
      })
      return
    }
    const generation = get().heimdallFleetGeneration + 1
    set({
      heimdallFleetGeneration: generation,
      heimdallFleetLoading: true,
      heimdallFleetError: null
    })
    try {
      const snapshot = await api.fleet()
      if (get().heimdallFleetGeneration !== generation) {
        return
      }
      get().applyHeimdallFleetSnapshot(snapshot)
      set({ heimdallFleetLoading: false })
    } catch (error) {
      if (get().heimdallFleetGeneration !== generation) {
        return
      }
      set({ heimdallFleetLoading: false, heimdallFleetError: describeError(error) })
    }
  },
  applyHeimdallFleetSnapshot: (snapshot) =>
    set((state) => {
      if (state.heimdallFleet && snapshot.generatedAtMs < state.heimdallFleet.generatedAtMs) {
        return state
      }
      const selected = state.heimdallSelectedTarget
      const selectionStillExists =
        !selected || snapshot.entries.some((row) => sameTarget(row.target, selected))
      return {
        heimdallFleet: snapshot,
        heimdallFleetError: null,
        ...(selectionStillExists ? {} : { heimdallSelectedTarget: null })
      }
    }),
  selectHeimdallWatcher: (target) => set({ heimdallSelectedTarget: target }),
  openHeimdallPage: () => {
    get().recordViewVisit('heimdall')
    set((state) => ({
      activeView: 'heimdall',
      previousViewBeforeHeimdall:
        state.activeView === 'heimdall' ? state.previousViewBeforeHeimdall : state.activeView
    }))
  },
  closeHeimdallPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeHeimdall,
      heimdallSelectedTarget: null,
      worktreeNavHistoryIndex: rewindHistoryIndexPastView(state, 'heimdall')
    }))
})
