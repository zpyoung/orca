import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { journalPendingSubmissionResolutions } from '../agent-session-journal/journal-pending-submission-recovery'
import {
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from '../agent-session-journal/journal-row-builders'
import {
  endedUnseenMessageBody,
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import type { ResolveDispatchInput } from '../agent-session-journal/journal-store-contracts'
import { lostLiveWorkJournalBody } from '../agent-session-journal/journal-subagent-liveness'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  hasStructuredAgentSessionStartFailureRow,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
import {
  runningTurnLifecycleRevisions,
  lastProvenTurnLiveAt,
  turnVerdictFromDeathEvidence,
  turnVerdictFromReplacedRuntime,
  watchedExitRevisions,
  type StructuredAgentSessionTurnVerdict,
  type StructuredAgentSessionWatchedExit
} from './structured-agent-session-stale-turn-verdict'
import {
  exitedRootTurnScope,
  settledRootTurnScope
} from './structured-agent-session-exit-turn-scope'
import {
  hasUnfinishedStructuredAgentSessionWork,
  type DeadGenerationJournal
} from './structured-agent-session-unfinished-work'
import { codexUnopenedSendResolutions } from './structured-agent-session-unopened-send-withdrawal'
import type { AgentSessionReplacedRuntime } from '../../runtime/agent-session-replaced-runtime'
import {
  isUnverifiableTurn,
  staleStopRow,
  type StaleCut
} from './structured-agent-session-stale-stop-row'

export { settleStaleStructuredAgentSessionState } from './structured-agent-session-stale-state-settlement'

/** Bounds the exit reason the lease keeps as log evidence; a provider diagnostic is held to the
 *  same cap. */
export const MAX_UNEXPECTED_EXIT_REASON_CHARS = MAX_PROVIDER_DIAGNOSTIC_CHARS

export type StructuredAgentSessionDeadGenerationInput = {
  journal: DeadGenerationJournal
  sessionId: string
  /** The fence the rows are written at: the lease's current one once the exit released it. */
  fence: number
  settlementId: string
  verdict: StructuredAgentSessionTurnVerdict
  pendingSubmissionReason: string
  showUnexpectedExitOutcome?: boolean
  /** Why the provider stopped, as the adapter told it; the row's sentence is this fact's. */
  exitFailure?: SubmissionRejectionFact
  /** Who a failed start's sentence names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The provider never finished starting: the start that failed, keyed by the child's
   *  generation. Its row is the one the delivery loop writes for the same start. */
  exitedDuringStartup?: { generation: string | null }
  /** The exit, watched: what that child's own translator could only end `unverifiable` (its stream
   *  closed before the exit was proven) is revised in this batch. */
  exit?: StructuredAgentSessionWatchedExit
  /** A person's Stop ended a starting child before what it was handed could run: each is rejected so. */
  unrunRejection?: SubmissionRejectionFact
}

/**
 * Settles whatever a generation with no child in this process left running: found when a new child
 * is acquired, or when a chat is reopened for reading. Derived from the journal, the lease's death
 * evidence and the runtimes this one replaced each time, so nothing is owed in between. Either proof
 * ends the turn interrupted, and a proof written after an earlier settle revises what that settle
 * left `unverifiable`, the turn and the calls it closed alike. Must run before a new child's
 * buffered events land, or a live turn would be judged.
 */
export async function settleStaleStructuredAgentSessionState(input: {
  journal: AgentSessionJournal
  sessionId: string
  fence: number
  acquisitionGeneration: string | null
  deathEvidence: AgentSessionDeathEvidence | null
  /** The runtimes this one replaced for this chat: every owner they held lost its pipes with them. */
  replaced?: AgentSessionReplacedRuntime
  /** Who the exit row names. */
  failureTextContext?: AgentSessionFailureWordsContext
}): Promise<number> {
  const { journal, replaced } = input
  const items = journal.snapshot().items
  // Each turn is judged by the evidence only if it names that turn's owner.
  const deathVerdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromDeathEvidence(
      input.deathEvidence,
      journal.itemFence(item.itemId),
      lastProvenTurnLiveAt(journal, item)
    )
  const replacedVerdictFor = (item: AgentJournalRenderItem) =>
    turnVerdictFromReplacedRuntime(
      replaced,
      journal.itemFence(item.itemId),
      lastProvenTurnLiveAt(journal, item)
    )
  const verdictFor = (item: AgentJournalRenderItem) => {
    const byDeath = deathVerdictFor(item)
    return byDeath.state === 'interrupted' ? byDeath : replacedVerdictFor(item)
  }
  // A successful settlement leaves terminal items; a failed transaction leaves the same prefix.
  const generation = input.acquisitionGeneration ?? `seq-${journal.cursor().sequence}`
  const settlementId = `${STALE_SESSION_ROW_PREFIX}${input.sessionId}:${input.fence}:${generation}`
  // Calls an earlier settle closed with no proof, revised once a proof names their owner.
  const mutations = provenUnverifiedToolCallRevisions(items, input.deathEvidence, journal, replaced)
  for (const item of items) {
    // Ended as its turn is: a proven death cuts a running call short. An open reasoning row is
    // ended too, but is not unfinished work: its running turn already says so.
    const end = runningCallEnd(item.turnScope, (id) => bodies.get(id), input.verdict.state)
    const terminal = endedUnseenMessageBody(item.body) ?? terminalAgentJournalBody(item.body, end)
    // One revision per item: its live subagents and background tasks end with it.
    const body = lostLiveWorkJournalBody(terminal ?? item.body) ?? terminal
    if (body) {
      mutations.push({
        kind: 'item',
        itemId: item.itemId,
        body,
        turnScope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
    }
  }
  const proven = provenUnverifiableTurnRevisions(items, input.deathEvidence, journal, replaced)
  const turnEnds = [
    ...items.flatMap((item) => runningTurnLifecycleRevisions([item], verdictFor(item))),
    ...proven
  ]
  mutations.push(...turnEnds)
  const stopRow = staleStopRow(input, items, (item): StaleCut => {
    const unverifiable = isUnverifiableTurn(item)
    if (!unverifiable && !isInProgressStructuredAgentSessionItem(item)) {
      return null
    }
    const fence = journal.itemFence(item.itemId)
    // An earlier settle's `unverifiable` turn is revised by a death naming its owner or by its replaced runtime.
    if (
      unverifiable
        ? fence !== undefined && fence === input.deathEvidence?.ownerFence
        : deathVerdictFor(item).state === 'interrupted'
    ) {
      return { by: 'death' }
    }
    return fence !== undefined && replacedVerdictFor(item).state === 'interrupted'
      ? { by: 'replaced', fence }
      : null
  })
  if (stopRow && !endedByPersonsStop(journal, turnEnds)) {
    mutations.unshift({ ...stopRow, turnScope: settledRootTurnScope(items, turnEnds) })
  }
  if (mutations.length > 0) {
    await journal.appendLifecycleBatch({
      settlementId,
      fence: input.fence,
      recovered: true,
      mutations
    })
  }
  return mutations.length
}

function withRevisions(
  items: readonly AgentJournalRenderItem[],
  revisions: readonly JournalLifecycleMutationInput[]
): AgentJournalRenderItem[] {
  const bodies = new Map(
    revisions.flatMap((revision): [string, AgentJournalItemBody][] =>
      revision.kind === 'item' ? [[journalLifecycleMutationItemId(revision), revision.body]] : []
    )
  )
  return items.map((item) => ({ ...item, body: bodies.get(item.itemId) ?? item.body }))
}
