import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../../core'
import { isTerminalAskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  ASK_DEFAULT_CHUNK_MS,
  validateAskSpec,
  type AskPartial,
  type AskRegistryEvent,
  type AskSpec
} from '../../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskDb } from '../../../../fork-ask-question-tool/ask-db'
import { validateAskAnswerSubmission } from './ask-answer-validation'
import { registryEventFromRow } from './ask-envelope-from-row'
import {
  cancelHandoff,
  commitHandoffAnswer,
  onHandoffAskChanged,
  resolveHandoffDispatch,
  updatePartialHandoff,
  waitHandoffChunk
} from './ask-handoff-lifecycle'
import { resolveAskAttribution, type AskAttribution } from './ask-pane-attribution'
import {
  AskAnswerParams,
  AskCancelParams,
  AskRegisterParams,
  AskSnapshotParams,
  AskSubscribeParams,
  AskUpdatePartialParams,
  AskWaitParams
} from './ask-schemas'

function buildNoUiUnavailableReason(attribution: AskAttribution): string {
  return attribution.anyIdentityClaimed
    ? 'no attached UI and no active orchestration run to hand off to'
    : 'no attached UI: set ORCA_PANE_KEY, ORCA_TERMINAL_HANDLE, ORCA_WORKTREE_ID, or ORCA_WORKSPACE_ID'
}

function formatSpecErrors(errors: { path: string; message: string }[]): string {
  return errors.map((error) => (error.path ? `${error.path}: ${error.message}` : error.message)).join('; ')
}

// Why: the returned seq is the max across every pending row, not just the paneKey-filtered ones
// a caller asked to see — a narrower watermark could later under-report what a broader resubscribe
// already covered, which is safe (a harmless duplicate), but the reverse (over-reporting) is not.
function buildPendingSnapshot(
  db: AskDb,
  epoch: string,
  paneKeyFilter?: string
): { asks: AskRegistryEvent[]; maxSeq: number } {
  const rows = db.listPending()
  const maxSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0)
  const filtered = paneKeyFilter === undefined ? rows : rows.filter((row) => row.pane_key === paneKeyFilter)
  return { asks: filtered.map((row) => registryEventFromRow(row, epoch)), maxSeq }
}

let askSubscriptionSeq = 0

export const ASK_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'ask.register',
    params: AskRegisterParams,
    // C3/C4 own attribution and capability gating: register never blocks, and an ask is never
    // durably inserted for a surface no attached client can render.
    handler: async (params, { runtime }) => {
      const validation = validateAskSpec(params.spec)
      if (!validation.ok) {
        throw new Error(formatSpecErrors(validation.errors))
      }
      const attribution = resolveAskAttribution(params, runtime)
      const { registry, roster } = runtime.getAskServices()

      if (attribution.paneKey && roster.hasCapableOwner(attribution.paneKey)) {
        return registry.register(
          validation.spec,
          { paneKey: attribution.paneKey, worktreeId: attribution.worktreeId },
          { requestId: params.requestId, timeoutMs: params.timeoutMs }
        )
      }

      const handoff = resolveHandoffDispatch(attribution, runtime)
      if (handoff) {
        // Why: hand-off blocking uses clampOrchestrationAskTimeoutMs (C7), never the registry's
        // own --timeout-ms expiry timer, so no timeoutMs is passed through here.
        return registry.register(
          validation.spec,
          { paneKey: null, worktreeId: attribution.worktreeId, handoff },
          { requestId: params.requestId }
        )
      }

      return { status: 'unavailable' as const, reason: buildNoUiUnavailableReason(attribution) }
    }
  }),

  defineMethod({
    name: 'ask.wait',
    params: AskWaitParams,
    handler: async (params, { runtime, signal }) => {
      const { db, registry } = runtime.getAskServices()
      const chunkMs = params.chunkMs ?? ASK_DEFAULT_CHUNK_MS
      const waitSignal = signal ?? new AbortController().signal
      const row = db.getAsk(params.askId)
      if (row?.origin === 'handoff') {
        return waitHandoffChunk(runtime, db, params.askId, chunkMs, waitSignal)
      }
      return registry.waitChunk(params.askId, chunkMs, waitSignal)
    }
  }),

  defineMethod({
    name: 'ask.answer',
    params: AskAnswerParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (!row || isTerminalAskStatus(row.status)) {
        return { committed: false }
      }
      const spec = JSON.parse(row.spec_json) as AskSpec
      const validation = validateAskAnswerSubmission(spec, params.answers, params.skipped)
      if (!validation.ok) {
        throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '))
      }
      if (row.origin === 'handoff') {
        return commitHandoffAnswer(runtime, db, params.askId, validation.answers, validation.skipped)
      }
      return registry.answer(params.askId, validation.answers, validation.skipped)
    }
  }),

  defineMethod({
    name: 'ask.updatePartial',
    params: AskUpdatePartialParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (row?.origin === 'handoff') {
        updatePartialHandoff(runtime, db, params.askId, params.partial as AskPartial)
      } else {
        registry.updatePartial(params.askId, params.partial as AskPartial)
      }
      return { ok: true as const }
    }
  }),

  defineMethod({
    name: 'ask.cancel',
    params: AskCancelParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const row = db.getAsk(params.askId)
      if (row?.origin === 'handoff') {
        return cancelHandoff(runtime, db, params.askId)
      }
      registry.cancel(params.askId, 'agent')
      // Why: cancel() returns a bare CommitResult; waitChunk on the now-terminal ask resolves the
      // envelope immediately (its resolved-ask fast path) without reimplementing envelope-building.
      return registry.waitChunk(params.askId, 0, new AbortController().signal)
    }
  }),

  defineMethod({
    name: 'ask.snapshot',
    params: AskSnapshotParams,
    handler: async (params, { runtime }) => {
      const { db, registry } = runtime.getAskServices()
      const epoch = registry.getEpoch()
      const { asks, maxSeq } = buildPendingSnapshot(db, epoch, params.paneKey)
      return { asks, seq: maxSeq, epoch }
    }
  }),

  defineStreamingMethod({
    name: 'ask.subscribe',
    params: AskSubscribeParams,
    handler: async (params, { runtime, connectionId }, emit) => {
      const { db, registry } = runtime.getAskServices()
      const epoch = registry.getEpoch()
      const needsSnapshot = params.sinceSeq === undefined || params.epoch !== epoch

      await new Promise<void>((resolve) => {
        let liveMode = false
        const buffered: AskRegistryEvent[] = []
        const relay = (event: AskRegistryEvent): void => {
          if (liveMode) {
            emit({ type: 'event', event })
          } else {
            buffered.push(event)
          }
        }
        const unsubscribeRegistry = registry.onAskChanged(relay)
        const unsubscribeHandoff = onHandoffAskChanged(runtime, relay)

        // Why: everything below reads state after already listening live, so nothing published
        // between that read and now can be missed — only double-delivered, which the trailing
        // buffered-event filter below (seq > catchupThroughSeq) prevents.
        let catchupThroughSeq: number
        if (needsSnapshot) {
          const { asks, maxSeq } = buildPendingSnapshot(db, epoch)
          for (const event of asks) {
            emit({ type: 'snapshot', event })
          }
          catchupThroughSeq = maxSeq
          emit({ type: 'watermark', seq: catchupThroughSeq, epoch })
        } else {
          const sinceSeq = params.sinceSeq as number
          const missed = db.listSinceSeq(sinceSeq)
          for (const row of missed) {
            emit({ type: 'event', event: registryEventFromRow(row, epoch) })
          }
          catchupThroughSeq = missed.at(-1)?.seq ?? sinceSeq
        }
        for (const event of buffered) {
          if (event.seq > catchupThroughSeq) {
            emit({ type: 'event', event })
          }
        }
        buffered.length = 0
        liveMode = true

        const subscriptionId = `ask-${connectionId ?? 'inproc'}-${++askSubscriptionSeq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribeRegistry()
            unsubscribeHandoff()
            emit({ type: 'end', reason: 'closed' })
            resolve()
          },
          connectionId
        )
      })
    }
  })
]
