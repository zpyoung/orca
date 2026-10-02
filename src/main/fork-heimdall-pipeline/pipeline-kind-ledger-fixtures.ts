import { mkdir, writeFile } from 'node:fs/promises'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { dirname } from 'node:path'
import { vi } from 'vitest'
import type { DispatchResult, DispatchWorkerInput } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherCommand, WatcherCommandResult } from '../../shared/fork-heimdall/fleet-types'
import type { EvidenceEntry } from '../../shared/fork-heimdall/ledger-types'
import type { NodeType } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { EnrollInput, EnrollResult } from '../../shared/fork-heimdall/watcher-types'
import { HeimdallBudgetClock } from '../fork-heimdall/budget-clock'
import { HeimdallDatabase } from '../fork-heimdall/database'
import { HeimdallKernelServiceImpl } from '../fork-heimdall/kernel-service'
import { HeimdallLedgerStore } from '../fork-heimdall/ledger-store'
import type { LeaseStore } from '../fork-heimdall/lease-store'
import type { HeimdallOrchestrationAdapter } from '../fork-heimdall/orchestration/orchestration-adapter'
import type { WatcherRunnerDependencies } from '../fork-heimdall/runner-state'
import { createHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { bindHeimdallKernel } from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import { bindHeimdallPipeline } from './pipeline-binding'
import { PipelineDatabase } from './pipeline-database'
import { PipelineAwareEnrollmentStore } from './pipeline-aware-enrollment-store'
import { PipelineStore } from './pipeline-store'
import { createPipelineKind } from './pipeline-kind'
import { createSitterCompositeAdapters } from './sitter-composite'
import type { PipelineWorkspaceTarget } from './pipeline-report-path'
import type { PipelineKindWorkspaceFixture } from './pipeline-kind-workspace-fixtures'

async function dispatchWorkspaceTarget(
  input: DispatchWorkerInput,
  workspace: PipelineKindWorkspaceFixture
): Promise<PipelineWorkspaceTarget> {
  const worktreeId = input.workspaceId ?? input.enrollment.worktreeId
  const target =
    workspace.workspaceKind === 'git' && worktreeId !== null
      ? await workspace.resolveGitTarget(worktreeId)
      : null
  const workspacePath = target?.worktree.path ?? input.enrollment.workspacePath
  const executionHostId = target?.executionHostId ?? input.enrollment.executionHostId
  const gitDir =
    workspace.workspaceKind === 'git'
      ? (
          await gitExecFileAsync(['rev-parse', '--absolute-git-dir'], {
            cwd: workspacePath,
            admissionTier: 'background'
          })
        ).stdout.trim()
      : null
  return {
    workspaceKind: workspace.workspaceKind,
    ...(gitDir === null ? {} : { gitDir }),
    workspacePath,
    executionHostId,
    ...(target === null ? {} : { workspaceId: target.worktree.id })
  }
}

export type PipelineDispatchContext = Readonly<{
  dispatchId: string
  workspaceTarget: PipelineWorkspaceTarget
  enqueueWorkerDone(input: {
    enrollment: DispatchWorkerInput['enrollment']
    dispatchId: string
    taskId: string
    reportPath: string
    outcome?: 'succeeded' | 'failed'
    filesModified?: string[]
  }): void
  writeReport(reportPath: string, report: unknown): Promise<void>
}>

export type PipelineKindLedgerOptions = Readonly<{
  storageAuthority?: 'desktop' | 'runtime'
  hostNodeTypes?: ReadonlySet<NodeType>
  onDispatch?: (
    input: DispatchWorkerInput,
    context: PipelineDispatchContext
  ) => Promise<DispatchResult> | DispatchResult
}>

export type PipelineKindLedgerFixture = Readonly<{
  database: HeimdallDatabase
  enrollmentStore: PipelineAwareEnrollmentStore
  pipelineDatabase: PipelineDatabase
  pipelineStore: PipelineStore
  service: HeimdallKernelServiceImpl
  dispatched: DispatchWorkerInput[]
  mailboxDelivered: EvidenceEntry[]
  enroll(input: EnrollInput): Promise<EnrollResult>
  tick(watcherId: string): Promise<void>
  command(watcherId: string, command: WatcherCommand): Promise<WatcherCommandResult>
  close(): Promise<void>
}>

export async function createPipelineKindLedgerFixture(
  workspace: PipelineKindWorkspaceFixture,
  options: PipelineKindLedgerOptions = {}
): Promise<PipelineKindLedgerFixture> {
  const { profile, runtime, store } = workspace
  let database: HeimdallDatabase | null = null
  let pipelineDatabase: PipelineDatabase | null = null
  let service: HeimdallKernelServiceImpl | null = null
  try {
    database = new HeimdallDatabase(profile)
    const enrollmentStore = new PipelineAwareEnrollmentStore(database)
    const ledgerStore = new HeimdallLedgerStore(database)
    const budgetClock = new HeimdallBudgetClock(ledgerStore)
    pipelineDatabase = new PipelineDatabase(profile)
    const pipelineStore = new PipelineStore(pipelineDatabase)
    bindHeimdallPipeline(runtime, { store, pipelineStore })
    let now = 20_000
    let nextId = 0
    let nextDispatch = 0
    let nextMailboxSequence = 0
    const queue: EvidenceEntry[] = []
    const dispatched: DispatchWorkerInput[] = []
    const mailboxDelivered: EvidenceEntry[] = []
    const leaseGuard = {
      epoch: 1,
      holder: 'pipeline-kind-test-holder',
      assertHeld: async () => undefined,
      renewLoop: () => ({ dispose: () => undefined })
    }
    const leaseStore: LeaseStore = {
      acquireOrRenew: async () => ({ status: 'held', epoch: 1, guard: leaseGuard }),
      release: async () => undefined
    }
    const orchestration: HeimdallOrchestrationAdapter = {
      ensureRun: vi.fn(async () => ({ runId: 'pipeline-kind-test-run' })),
      dispatchWorker: vi.fn(async (input: DispatchWorkerInput) => {
        const dispatchId = `pipeline-kind-dispatch-${++nextDispatch}`
        dispatched.push(input)
        const workspaceTarget = await dispatchWorkspaceTarget(input, workspace)
        const context: PipelineDispatchContext = {
          dispatchId,
          workspaceTarget,
          enqueueWorkerDone: (done) => {
            const sequence = ++nextMailboxSequence
            queue.push({
              eventId: `pipeline-kind-mail-${sequence}`,
              watcherId: done.enrollment.watcherId,
              atMs: ++now,
              origin: 'owner',
              class: 'fact',
              kind: 'evidence',
              evidenceKind: 'orchestration-mailbox',
              source: {
                kind: 'orchestration',
                sequence,
                messageId: `pipeline-kind-message-${sequence}`,
                deliveryId: `pipeline-kind-delivery-${sequence}`
              },
              payload: {
                type: 'worker_done',
                body: 'Pipeline Agent report was written.',
                payload: {
                  dispatchId: done.dispatchId,
                  taskId: done.taskId,
                  outcome: done.outcome ?? 'succeeded',
                  reportPath: done.reportPath,
                  filesModified: done.filesModified ?? []
                }
              }
            })
          },
          writeReport: async (reportPath, report) => {
            await mkdir(dirname(reportPath), { recursive: true })
            await writeFile(reportPath, JSON.stringify(report))
          }
        }
        if (options.onDispatch !== undefined) {
          return await options.onDispatch(input, context)
        }
        return {
          status: 'dispatched',
          dispatchId,
          terminalHandle: 'pipeline-kind-test-terminal'
        } satisfies DispatchResult
      }),
      recoverDispatch: vi.fn(async () => ({ status: 'absent' as const })),
      readDispatch: vi.fn(async () => ({ status: 'live' as const })),
      readAuthoritativeWorkerReport: vi.fn(async () => null),
      listWorkers: vi.fn(async () => []),
      stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: now })),
      releaseWorker: vi.fn(
        async (_enrollment: DispatchWorkerInput['enrollment'], dispatchId: string) => ({
          dispatchId,
          state: 'released' as const,
          processAction: 'closed_agent_terminal' as const,
          archive: null
        })
      ),
      drainMailbox: vi.fn(async () => {
        const entries = queue.splice(0)
        mailboxDelivered.push(...entries)
        return entries
      }),
      answerQuestion: vi.fn(async () => undefined),
      readQuestion: vi.fn(async () => ({ status: 'pending' as const })),
      observeWorkerIdle: vi.fn(async () => ({ status: 'active' as const })),
      sendWorkerPrompt: vi.fn(async () => undefined)
    }
    const storageAuthority = options.storageAuthority ?? 'desktop'
    const hostedReviewKind = createHostedReviewKind(runtime, store, storageAuthority)
    const sitterAdapters = createSitterCompositeAdapters({
      runtime,
      store,
      pipelineStore,
      hostedReviewKind,
      storageAuthority
    })
    const schedule: NonNullable<WatcherRunnerDependencies['setTimer']> = new Proxy(setTimeout, {
      apply: (target, thisArg, args: Parameters<typeof setTimeout>) => {
        const timer = target.apply(thisArg, args)
        clearTimeout(timer)
        return timer
      }
    })
    service = new HeimdallKernelServiceImpl({
      runtime,
      store,
      storageAuthority,
      database,
      enrollmentStore,
      ledgerStore,
      budgetClock,
      leaseStore,
      orchestration,
      now: () => ++now,
      createId: () => `pipeline-kind-id-${++nextId}`,
      setTimer: schedule
    })
    service.registerKind(
      createPipelineKind({
        runtime,
        store,
        pipelineStore,
        storageAuthority,
        ...(options.hostNodeTypes === undefined ? {} : { hostNodeTypes: options.hostNodeTypes }),
        nowMs: () => now,
        ...sitterAdapters
      })
    )
    bindHeimdallKernel(runtime, service)

    let closed = false
    const close = async (): Promise<void> => {
      if (closed) {
        return
      }
      closed = true
      await service?.stopForShutdown()
      pipelineDatabase?.close()
      database?.close()
    }
    return {
      database,
      enrollmentStore,
      pipelineDatabase,
      pipelineStore,
      service,
      dispatched,
      mailboxDelivered,
      async enroll(input) {
        return await service!.enroll(input)
      },
      tick: async (watcherId) => await service!.reconcileForTesting(watcherId),
      command: async (watcherId, command) => {
        const fleet = await service!.fleet()
        const target = fleet.entries.find((entry) => entry.target.watcherId === watcherId)
        if (target === undefined) {
          throw new Error(`Pipeline test watcher is absent from the fleet: ${watcherId}`)
        }
        return await service!.command({
          target: target.target,
          expectedOwner: target.ownerFence,
          command
        })
      },
      close
    }
  } catch (error) {
    await service?.stopForShutdown()
    pipelineDatabase?.close()
    database?.close()
    throw error
  }
}
