import { pipelineContentHash } from './pipeline-canonical-hash'
import { parsePipelineText } from './pipeline-parse'
import type { PipelineEnrollmentPayload } from './enrollment-payload'
import type { PipelinePin } from './pipeline-pin'
import type { PipelineStoreFacts } from './store-facts'
import type { PipelineWorld } from './interpreter'
import type {
  ApprovalScope,
  AttemptEntry,
  AttemptResolvedEntry,
  EvidenceEntry,
  EscalationEntry,
  KernelAction,
  WatcherLedger
} from '../fork-heimdall/ledger-types'
import type { Deviation } from '../fork-heimdall/owner/deviation'
import { ownerDeviationEscalationId } from '../fork-heimdall/owner/deviation'
import type { PipelineChoice, PipelineAnswerEvidence } from './choice-types'

const DEFAULT_PIPELINE = `version: 1
id: bugfix
name: Bugfix
nodes:
  - id: repro
    type: agent
    prompt: Reproduce the bug
  - id: fix
    type: agent
    after: [repro]
    prompt: Fix the bug
`

export function pipelinePayload(yamlText = DEFAULT_PIPELINE): PipelineEnrollmentPayload {
  const parsed = parsePipelineText(yamlText)
  if (parsed.document === null) {
    throw new Error(`Invalid pipeline fixture: ${JSON.stringify(parsed.errors)}`)
  }
  const pin: PipelinePin = {
    ref: parsed.document.id,
    scope: 'repo',
    id: parsed.document.id,
    contentHash: pipelineContentHash(parsed.document),
    documentVersion: 1
  }
  return {
    schemaVersion: 1,
    pin,
    document: parsed.document,
    sourceText: yamlText,
    runInputs: { task: 'Implement the requested change' },
    workspaceKind: 'git'
  }
}

export function world(overrides: Partial<PipelineWorld> = {}): PipelineWorld {
  const payload = overrides.payload ?? pipelinePayload()
  const facts: PipelineStoreFacts = overrides.facts ?? {
    pin: { ...payload.pin, runNumber: 1 },
    outputs: [],
    dispatches: [],
    swarmExpansions: [],
    childWorktrees: [],
    mergeProgress: [],
    composites: []
  }
  return {
    watcherId: 'watcher-1',
    payload,
    nowMs: 1_000,
    hasOwner: false,
    grants: { agent: 'on', check: 'on', script: 'on', integrate: 'on', gate: 'on', pipeline: 'on' },
    workspacePath: '/workspace',
    unverifiableDispatchIds: new Set(),
    composites: {},
    ...overrides,
    facts
  }
}

export function attemptEntry(
  action: KernelAction,
  state: AttemptEntry['state'] = 'settled',
  atMs = 1_000,
  options: {
    attemptId?: string
    effect?: AttemptEntry['effect']
    reason?: string
    failureClass?: AttemptEntry['failureClass']
    dispatchId?: string
    result?: unknown
  } = {}
): AttemptEntry {
  const attemptId = options.attemptId ?? `attempt:${action.kind}:${action.evidenceKey}`
  return {
    kind: 'attempt',
    eventId: `event:${attemptId}:${state}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    attemptId,
    fingerprint: JSON.stringify([action.contentIdentity, action.kind, action.evidenceKey]),
    action,
    state,
    ...(options.effect === undefined ? {} : { effect: options.effect }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.failureClass === undefined ? {} : { failureClass: options.failureClass }),
    ...(options.dispatchId === undefined ? {} : { dispatchId: options.dispatchId }),
    ...(options.result === undefined ? {} : { result: options.result })
  }
}

export function resolved(
  attemptId: string,
  effect: AttemptResolvedEntry['effect'],
  failureClass?: AttemptResolvedEntry['failureClass']
): AttemptResolvedEntry {
  return {
    kind: 'attempt-resolved',
    eventId: `resolved:${attemptId}`,
    watcherId: 'watcher-1',
    atMs: 1_001,
    origin: 'owner',
    class: 'fact',
    attemptId,
    effect,
    evidence: {},
    ...(failureClass === undefined ? {} : { failureClass })
  }
}

export function answerEvidence(
  scope: ApprovalScope,
  choice: PipelineChoice,
  extras: Partial<
    Pick<
      PipelineAnswerEvidence,
      | 'comment'
      | 'extendMinutes'
      | 'approvalEventId'
      | 'attribution'
      | 'attemptId'
      | 'attemptFingerprint'
    >
  > = {}
): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `answer:${scope.evidenceKey}`,
    watcherId: 'watcher-1',
    atMs: 1_002,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'pipeline-answer',
    payload: {
      approvalEventId: extras.approvalEventId ?? `approval:${scope.evidenceKey}`,
      scope,
      choice,
      ...extras,
      attribution: extras.attribution ?? {
        actor: { user: 'alice', host: 'laptop' },
        surface: 'cli',
        atMs: 1_002
      }
    }
  }
}

export function ownerEscalation(
  deviation: Extract<Deviation, { kind: 'pipeline-node' }>,
  status: EscalationEntry['status']
): EscalationEntry {
  const escalationId = ownerDeviationEscalationId('watcher-1', deviation)
  return {
    kind: 'escalation',
    eventId: `${escalationId}:${status}`,
    watcherId: 'watcher-1',
    atMs: 1_003,
    origin: 'owner',
    class: 'fact',
    escalationId,
    escalationKind: 'owner-deviation',
    status,
    foldCount: 1
  }
}

export function nodeOutputs(
  instanceId: string,
  epoch: number,
  attempt: number,
  outputs: Record<string, unknown>
): PipelineStoreFacts['outputs'][number] {
  return { instanceId, epoch, attempt, outputs, reportSha256: null }
}

export function emptyLedger(entries: WatcherLedger['entries'] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}
