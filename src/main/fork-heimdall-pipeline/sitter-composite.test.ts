import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type {
  AttemptEntry,
  KernelAction,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { ExecuteContext, LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { executeSitterCompositeActivation } from './sitter-composite-activation'
import {
  compareCompositeAttemptProtectedFiles,
  compositeProtectedOutcome,
  compositeProtectedSubmissionResult,
  dispatchCompositeWorkerWithProtectedBaseline
} from './composite-node-host'
import { PipelineDatabase } from './pipeline-database'
import { PipelineStore } from './pipeline-store'
import { createHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { createSitterCompositeAdapters } from './sitter-composite'
const { getHostedReviewForBranchMock } = vi.hoisted(() => ({
  getHostedReviewForBranchMock: vi.fn<() => Promise<HostedReviewInfo | null>>()
}))

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))

const AUTHORIZED_REVIEW: HostedReviewInfo = {
  provider: 'github',
  number: 42,
  title: 'Review created by Land',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/42',
  status: 'pending',
  updatedAt: '2026-10-01T00:00:00.000Z',
  mergeable: 'UNKNOWN'
}

beforeEach(() => {
  getHostedReviewForBranchMock.mockReset()
  getHostedReviewForBranchMock.mockResolvedValue(AUTHORIZED_REVIEW)
})

const roots: string[] = []
const databases: PipelineDatabase[] = []

async function protectedWorkspace(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'orca-sitter-composite-protection-'))
  roots.push(root)
  await mkdir(join(root, '.orca', 'pipelines'), { recursive: true })
  await writeFile(join(root, '.orca', 'pipelines', 'review.yaml'), 'version: 1\n')
  return root
}

function enrollment(workspacePath: string, kindPayload: unknown = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'pipeline',
    workspaceKey: `local::${workspacePath}`,
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath,
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { pipeline: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

function compositeAction(): KernelAction {
  return {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    contentIdentity: 'pipeline:content-hash',
    evidenceKey: 'outer-evidence-key',
    pipelineNode: {
      instanceId: 'review',
      nodeId: 'review',
      epoch: 0,
      attempt: 1,
      inner: { contentIdentity: 'sitter-head', evidenceKey: 'prepare-fix:head-1' }
    }
  }
}
function activationFixture() {
  const sourceText = `version: 1
id: bugfix-copy
name: Bugfix copy
nodes:
  - id: land
    type: land
  - id: review
    type: pr-sitter
    after: [land]
    repeatFixLimit: 4
    branchUpdateMode: rebase
    mergeMethod: squash
    mergeCheckScope: required
`
  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw new Error('The sitter activation pipeline fixture must parse')
  }
  const pin: PipelinePin = {
    ref: 'repo:bugfix-copy',
    scope: 'repo',
    id: parsed.document.id,
    contentHash: pipelineContentHash(parsed.document),
    documentVersion: parsed.document.version
  }
  const payload = PipelineEnrollmentPayloadSchema.parse({
    schemaVersion: 1,
    pin,
    document: parsed.document,
    sourceText,
    runInputs: {},
    workspaceKind: 'git'
  })
  const runEnrollment = enrollment('/repo/worktree', payload)
  const grants = {
    agent: 'on',
    check: 'on',
    script: 'on',
    integrate: 'on',
    land: 'on',
    push: 'gated',
    updateBranch: 'gated',
    resolveConflicts: 'on',
    fixChecks: 'gated',
    merge: 'off',
    gate: 'on',
    pipeline: 'on'
  } as const
  const prUrl = AUTHORIZED_REVIEW.url
  const outputs = {
    prUrl,
    prNumber: AUTHORIZED_REVIEW.number,
    branch: 'feature/review',
    provider: 'github'
  }
  const facts: PipelineStoreFacts = {
    pin: { ...pin, runNumber: 1 },
    outputs: [
      {
        instanceId: 'land',
        epoch: 0,
        attempt: 0,
        outputs,
        reportSha256: null
      }
    ],
    dispatches: [],
    swarmExpansions: [],
    childWorktrees: [],
    mergeProgress: [],
    composites: []
  }
  const landingAction = buildPipelineAction({
    kind: 'pipeline-land-open-review',
    capability: 'land',
    visibility: 'external',
    pin,
    instanceId: 'land',
    nodeId: 'land',
    epoch: 0,
    attempt: 0
  })
  const landingAttempt: AttemptEntry = {
    eventId: 'land-event',
    watcherId: runEnrollment.watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'land-attempt',
    fingerprint: makeAttemptFingerprint(
      landingAction.contentIdentity,
      landingAction.kind,
      landingAction.evidenceKey
    ),
    action: landingAction,
    state: 'settled',
    effect: 'landed'
  }
  const ledger: WatcherLedger = {
    watcherId: runEnrollment.watcherId,
    entries: [landingAttempt]
  }
  const world: PipelineReadyWorld = {
    watcherId: runEnrollment.watcherId,
    payload,
    facts,
    nowMs: 100,
    hasOwner: false,
    grants,
    workspacePath: runEnrollment.workspacePath,
    unverifiableDispatchIds: new Set(),
    composites: {},
    enrollment: runEnrollment,
    ledger
  }
  const contentIdentity = `pipeline:${pin.contentHash}`
  const action = buildPipelineAction({
    kind: 'pipeline-activate-composite',
    capability: 'pipeline',
    visibility: 'local',
    pin,
    instanceId: 'review',
    nodeId: 'review',
    epoch: 0,
    attempt: 0,
    fields: {
      landInstanceId: 'land',
      prUrl,
      prNumber: AUTHORIZED_REVIEW.number,
      branch: 'feature/review',
      provider: 'github',
      repeatFixLimit: 4,
      branchUpdateMode: 'rebase',
      mergeMethod: 'squash',
      mergeCheckScope: 'required',
      capabilities: grants
    }
  })
  const evidence: { evidenceKind: string; payload: Readonly<Record<string, unknown>> }[] = []
  const lease: LeaseGuard = {
    epoch: 1,
    holder: 'composite-test',
    assertHeld: async () => {},
    renewLoop: () => ({ dispose: () => {} })
  }
  const context: ExecuteContext<PipelineKindWorld> = {
    snapshot: { freshness: 'live', contentIdentity, observedAtMs: 100, world },
    lease,
    ledger,
    dispatchWorker: async () => ({
      status: 'refused',
      reason: 'fenced',
      detail: 'unused'
    }),
    appendEvidence: async (evidenceKind, payload) => {
      evidence.push({ evidenceKind, payload })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization only calls showManagedWorktree.
  const runtime = {
    showManagedWorktree: async () => ({
      id: 'worktree-1',
      repoId: 'repo-1',
      git: {
        path: '/repo/worktree',
        branch: 'refs/heads/feature/review',
        head: 'a'.repeat(40),
        isBare: false,
        prunable: false
      }
    })
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization only calls getRepo and getWorktreeMeta.
  const store = {
    getRepo: () => ({ id: 'repo-1', path: '/repo', executionHostId: 'local' }),
    getWorktreeMeta: () => undefined
  } as unknown as Store
  return { action, context, evidence, runtime, store }
}

describe('PR-sitter composite protected workers', () => {
  afterEach(() => {
    for (const database of databases) {
      database.close()
    }
    databases.length = 0
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
    roots.length = 0
  })

  it('captures before dispatch and rejects a changed protected file at report and outcome boundaries', async () => {
    const workspacePath = await protectedWorkspace()
    const database = new PipelineDatabase(':memory:')
    databases.push(database)
    const store = new PipelineStore(database)
    const watcher = enrollment(workspacePath)
    const action = compositeAction()
    const dispatch = async () => {
      await writeFile(join(workspacePath, '.orca', 'pipelines', 'review.yaml'), 'tampered\n')
      return { status: 'dispatched' as const, dispatchId: 'dispatch-1' }
    }

    await expect(
      dispatchCompositeWorkerWithProtectedBaseline({
        request: { spec: 'fix the review checks' },
        action,
        enrollment: watcher,
        pipelineStore: store,
        dispatchWorker: dispatch
      })
    ).resolves.toEqual({ status: 'dispatched', dispatchId: 'dispatch-1' })

    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const attempt: AttemptEntry = {
      eventId: 'attempt-event',
      watcherId: watcher.watcherId,
      atMs: 2,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-1',
      fingerprint,
      action,
      state: 'settled',
      effect: 'landed',
      dispatchId: 'dispatch-1'
    }
    const comparison = await compareCompositeAttemptProtectedFiles(attempt, watcher, store)

    expect(comparison).toMatchObject({
      status: 'changed',
      paths: ['.orca/pipelines/review.yaml']
    })
    expect(compositeProtectedSubmissionResult(comparison)).toMatchObject({
      status: 'rejected',
      code: 'protected-pipeline-files'
    })
    expect(compositeProtectedOutcome(attempt, comparison)).toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reportValidation: {
        code: 'evidence-mismatch',
        detail: 'protected-path-modified:.orca/pipelines/review.yaml'
      }
    })
  })
  it('authorizes the current Land review, persists restricted grants, and records activation evidence', async () => {
    const fixture = activationFixture()
    const database = new PipelineDatabase(':memory:')
    databases.push(database)
    const store = new PipelineStore(database)

    await expect(
      executeSitterCompositeActivation(fixture.action, fixture.context, {
        runtime: fixture.runtime,
        store: fixture.store,
        pipelineStore: store,
        storageAuthority: 'desktop'
      })
    ).resolves.toMatchObject({ effect: 'landed' })

    expect(store.composite('watcher-1', 'review', 0)).toMatchObject({
      kind: 'hosted-review',
      kindPayload: {
        branch: 'feature/review',
        provider: 'github',
        reviewNumber: 42,
        repeatFixLimit: 4
      },
      capabilities: {
        updateBranch: 'gated',
        resolveConflicts: 'on',
        fixChecks: 'gated',
        merge: 'off'
      }
    })
    expect(fixture.evidence).toMatchObject([
      {
        evidenceKind: 'pipeline-composite-activated',
        payload: {
          instanceId: 'review',
          kind: 'hosted-review',
          landInstanceId: 'land',
          prUrl: AUTHORIZED_REVIEW.url
        }
      }
    ])
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/review' })
    )
  })

  it('refuses a fresh authorization for a different Pull Request before writing activation state', async () => {
    const fixture = activationFixture()
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      ...AUTHORIZED_REVIEW,
      number: 43,
      url: 'https://github.com/acme/repo/pull/43'
    })
    const database = new PipelineDatabase(':memory:')
    databases.push(database)
    const store = new PipelineStore(database)

    await expect(
      executeSitterCompositeActivation(fixture.action, fixture.context, {
        runtime: fixture.runtime,
        store: fixture.store,
        pipelineStore: store,
        storageAuthority: 'desktop'
      })
    ).resolves.toMatchObject({ effect: 'not-landed', failureClass: 'criteria' })
    expect(store.composite('watcher-1', 'review', 0)).toBeNull()
    expect(fixture.evidence).toEqual([])
  })
  it('exposes only sitter-specific owner moves, never human or worker-answer gates', () => {
    const database = new PipelineDatabase(':memory:')
    databases.push(database)
    const fixture = activationFixture()
    const adapters = createSitterCompositeAdapters({
      runtime: fixture.runtime,
      store: fixture.store,
      pipelineStore: new PipelineStore(database),
      hostedReviewKind: createHostedReviewKind(fixture.runtime, fixture.store),
      storageAuthority: 'desktop'
    })
    const humanQuestion = { kind: 'ask-human', question: 'Approve this change?' }
    const workerReply = { kind: 'answer-worker', messageId: 'message-1', answer: 'yes' }

    expect(adapters.compositeOwner.interventionSchema.safeParse(humanQuestion).success).toBe(false)
    expect(adapters.compositeOwner.interventionSchema.safeParse(workerReply).success).toBe(false)
    expect(adapters.compositeOwner.isSitterIntervention(humanQuestion)).toBe(false)
    expect(
      adapters.compositeOwner.interventionSchema.safeParse({
        kind: 'retry-rung',
        rung: 'prepare-fix',
        rationale: 'Retry the landed check repair'
      }).success
    ).toBe(true)
  })
})
