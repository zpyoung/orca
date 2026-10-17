import type { StateCreator } from 'zustand'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import type { AppState } from '../store/types'

export type LoopSetupDialogState = { open: boolean; worktreeId?: string; groupId?: string }
export type LoopCloseConfirm = { loopId: string; tabId: string; onDone: () => void }

export type LoopsSlice = {
  loopsById: Record<string, LoopSnapshot>
  loopIdByPaneKey: Record<string, string>
  loopSetupDialog: LoopSetupDialogState
  loopCloseConfirm: LoopCloseConfirm | null
  hydrateLoops: () => Promise<void>
  applyLoopSnapshot: (snapshot: LoopSnapshot) => void
  openLoopSetup: (target: { worktreeId?: string; groupId?: string }) => void
  closeLoopSetup: () => void
  requestLoopCloseConfirm: (confirm: LoopCloseConfirm) => void
  /** Clears the pending confirmation and runs its `onDone` once; a second call is a no-op. */
  resolveLoopCloseConfirm: () => void
}

type LoopsState = Pick<LoopsSlice, 'loopsById' | 'loopIdByPaneKey'>

function paneKeyForLoop(
  loopIdByPaneKey: Record<string, string>,
  loopId: string
): string | undefined {
  return Object.keys(loopIdByPaneKey).find((paneKey) => loopIdByPaneKey[paneKey] === loopId)
}

function indexPaneKeys(loops: readonly LoopSnapshot[]): Record<string, string> {
  const loopIdByPaneKey: Record<string, string> = {}
  for (const loop of loops) {
    if (loop.tab) {
      loopIdByPaneKey[loop.tab.paneKey] = loop.id
    }
  }
  return loopIdByPaneKey
}

export function selectLoopForPaneKey(
  state: Pick<LoopsSlice, 'loopsById' | 'loopIdByPaneKey'>,
  paneKey: string
): LoopSnapshot | undefined {
  const loopId = state.loopIdByPaneKey[paneKey]
  return loopId ? state.loopsById[loopId] : undefined
}

const worktreeLoopsCache = new WeakMap<
  LoopsState['loopsById'],
  Map<string, readonly LoopSnapshot[]>
>()

/** Returns a referentially stable array until `loopsById` changes, so it is safe as a zustand selector. */
export function selectLoopsForWorktree(
  state: Pick<LoopsSlice, 'loopsById'>,
  worktreeId: string
): readonly LoopSnapshot[] {
  let byWorktree = worktreeLoopsCache.get(state.loopsById)
  if (!byWorktree) {
    byWorktree = new Map()
    worktreeLoopsCache.set(state.loopsById, byWorktree)
  }
  let loops = byWorktree.get(worktreeId)
  if (!loops) {
    loops = Object.values(state.loopsById).filter((loop) => loop.worktreeId === worktreeId)
    byWorktree.set(worktreeId, loops)
  }
  return loops
}

export const createLoopsSlice: StateCreator<AppState, [], [], LoopsSlice> = (set, get) => ({
  loopsById: {},
  loopIdByPaneKey: {},
  loopSetupDialog: { open: false },
  loopCloseConfirm: null,
  hydrateLoops: async () => {
    const api = window.api?.loops
    if (!api || typeof api.list !== 'function') {
      return
    }
    try {
      const loops = await api.list()
      set({
        loopsById: Object.fromEntries(loops.map((loop) => [loop.id, loop])),
        loopIdByPaneKey: indexPaneKeys(loops)
      })
    } catch {
      // an older or unreachable runtime has no loops; the rail and glyph simply stay absent
    }
  },
  applyLoopSnapshot: (snapshot) =>
    set((state) => {
      const loopIdByPaneKey = { ...state.loopIdByPaneKey }
      const previousPaneKey = paneKeyForLoop(loopIdByPaneKey, snapshot.id)
      if (previousPaneKey !== undefined) {
        delete loopIdByPaneKey[previousPaneKey]
      }
      if (snapshot.tab) {
        loopIdByPaneKey[snapshot.tab.paneKey] = snapshot.id
      }
      return {
        loopsById: { ...state.loopsById, [snapshot.id]: snapshot },
        loopIdByPaneKey
      }
    }),
  openLoopSetup: ({ worktreeId, groupId }) =>
    set({ loopSetupDialog: { open: true, worktreeId, groupId } }),
  closeLoopSetup: () => set({ loopSetupDialog: { open: false } }),
  requestLoopCloseConfirm: (confirm) => set({ loopCloseConfirm: confirm }),
  resolveLoopCloseConfirm: () => {
    const pending = get().loopCloseConfirm
    if (!pending) {
      return
    }
    set({ loopCloseConfirm: null })
    pending.onDone()
  }
})
