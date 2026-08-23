import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  AskPartial,
  AskRegistryEvent,
  AskRegistryResult,
  AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import { isTerminalAskStatus, type AskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'

/** Normalized per-ask state the card renders (tech.md § C8). Validation stays in the shared schema module. */
export type AskCardModel = {
  askId: string
  paneKey: string | null
  status: AskStatus
  spec: AskSpec | null
  partial: AskPartial
  result?: AskRegistryResult
}

type AskWatermark = { seq: number; epoch: string }
type AskSnapshotResult = { asks: AskRegistryEvent[]; seq: number; epoch: string }

export type AsksSlice = {
  /** Per-pane FIFO; index 0 is the ask the card renders. */
  pendingAsksByPaneKey: Record<string, AskCardModel[]>
  /** Null until `hydrateAsks` resolves once; also the "is hydrated" gate for `applyAskRegistryEvent`. */
  askWatermark: AskWatermark | null
  /** Events received while `askWatermark` is null; replayed in order once hydration resolves. */
  _askEventBuffer: AskRegistryEvent[]
  /** Seeds pending asks, their partials, and the watermark via `ask.snapshot`, then replays
   * anything `applyAskRegistryEvent` buffered while this call was in flight. */
  hydrateAsks: () => Promise<void>
  /** Applies one live registry event under the hydration-ordering rules in tech.md § C8. */
  applyAskRegistryEvent: (event: AskRegistryEvent) => void
}

/**
 * Merges a registry event onto the previously known card. A field the event omits keeps its
 * prior value rather than being cleared — events do not repeat fields that have not changed.
 */
function mergeAskCard(previous: AskCardModel | undefined, event: AskRegistryEvent): AskCardModel {
  return {
    askId: event.askId,
    paneKey: event.paneKey,
    status: event.status,
    spec: event.spec ?? previous?.spec ?? null,
    partial: event.partial ?? previous?.partial ?? {},
    result: event.result ?? previous?.result
  }
}

/** Updates a pane's array in place by askId, or appends — new asks queue behind the head. */
function upsertCard(bucket: AskCardModel[], event: AskRegistryEvent): AskCardModel[] {
  const index = bucket.findIndex((card) => card.askId === event.askId)
  const card = mergeAskCard(index === -1 ? undefined : bucket[index], event)
  return index === -1 ? [...bucket, card] : bucket.map((existing, i) => (i === index ? card : existing))
}

export const createAsksSlice: StateCreator<AppState, [], [], AsksSlice> = (set, get) => ({
  pendingAsksByPaneKey: {},
  askWatermark: null,
  _askEventBuffer: [],

  hydrateAsks: async () => {
    let snapshot: AskSnapshotResult
    try {
      const response = await window.api.runtime.call({ method: 'ask.snapshot', params: {} })
      snapshot = unwrapRuntimeRpcResult<AskSnapshotResult>(
        response as RuntimeRpcResponse<AskSnapshotResult>
      )
    } catch (error) {
      console.error('Failed to hydrate pending asks:', error)
      return
    }

    const seeded: Record<string, AskCardModel[]> = {}
    for (const event of snapshot.asks) {
      if (event.paneKey === null) {
        continue
      }
      seeded[event.paneKey] = upsertCard(seeded[event.paneKey] ?? [], event)
    }

    const buffered = get()._askEventBuffer
    set({
      pendingAsksByPaneKey: seeded,
      askWatermark: { seq: snapshot.seq, epoch: snapshot.epoch },
      _askEventBuffer: []
    })
    for (const event of buffered) {
      get().applyAskRegistryEvent(event)
    }
  },

  applyAskRegistryEvent: (event) => {
    const state = get()
    const watermark = state.askWatermark
    if (!watermark) {
      // buffered until hydrateAsks resolves — applying early would race the snapshot read and
      // could drop whichever of the two lands second, silently losing an active card
      set({ _askEventBuffer: [...state._askEventBuffer, event] })
      return
    }
    if (event.epoch !== watermark.epoch) {
      set({ pendingAsksByPaneKey: {}, askWatermark: null, _askEventBuffer: [] })
      void get().hydrateAsks()
      return
    }
    if (event.seq <= watermark.seq) {
      return
    }
    set({
      pendingAsksByPaneKey:
        event.paneKey === null
          ? state.pendingAsksByPaneKey
          : {
              ...state.pendingAsksByPaneKey,
              [event.paneKey]: upsertCard(state.pendingAsksByPaneKey[event.paneKey] ?? [], event)
            },
      askWatermark: { seq: event.seq, epoch: event.epoch }
    })
  }
})

export function selectHeadAsk(
  state: Pick<AsksSlice, 'pendingAsksByPaneKey'>,
  paneKey: string
): AskCardModel | null {
  return state.pendingAsksByPaneKey[paneKey]?.[0] ?? null
}

/** Non-terminal asks across every pane; the sidebar badge reads this. */
export function selectPendingAskCount(state: Pick<AsksSlice, 'pendingAsksByPaneKey'>): number {
  let count = 0
  for (const bucket of Object.values(state.pendingAsksByPaneKey)) {
    for (const card of bucket) {
      if (!isTerminalAskStatus(card.status)) {
        count += 1
      }
    }
  }
  return count
}
