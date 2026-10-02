import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import { captureProtectedDigest } from './protected-pipeline-files'
import { issuePipelineReportPath } from './pipeline-report-path'
import type {
  PipelineAgentReportActionKind,
  PipelineAgentReportContext
} from './agent-node-executor'
import { createPipelineSubmissionAdapter } from './submission-preflight'

const directories: string[] = []

async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'pipeline-preflight-'))
  directories.push(workspacePath)
  return workspacePath
}

function createEnrollment(workspacePath: string): WatcherEnrollment {
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
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: 'run-1',
    createdAtMs: 1,
    terminalAtMs: null
  }
}

type AgentAttemptFixture = Readonly<{
  actionKind?: PipelineAgentReportActionKind
  fingerprint?: string
  dispatchId?: string
  instanceId?: string
  nodeId?: string
  node?: PipelineAgentNode
  report?: unknown
}>

function createAttempt(input: AgentAttemptFixture = {}): AttemptEntry {
  const fingerprint = input.fingerprint ?? 'attempt-fingerprint'
  const instanceId = input.instanceId ?? 'implement'
  const nodeId = input.nodeId ?? 'implement'
  return {
    eventId: `event-${fingerprint}`,
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `attempt-${fingerprint}`,
    fingerprint,
    action: {
      kind: input.actionKind ?? 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      contentIdentity: 'pipeline:sha256:abc',
      evidenceKey: `key-${fingerprint}`,
      pipelineNode: { instanceId, nodeId, epoch: 0, attempt: 0 }
    },
    state: 'running',
    dispatchId: input.dispatchId ?? 'dispatch-1'
  }
}

function createNode(): PipelineAgentNode {
  return {
    id: 'implement',
    type: 'agent',
    prompt: 'Implement',
    outputs: { summary: { type: 'text' } }
  }
}

async function setup(input: AgentAttemptFixture = {}) {
  const workspacePath = await createWorkspace()
  const target = {
    executionHostId: 'local' as const,
    workspaceKind: 'folder' as const,
    workspacePath,
    workspaceId: 'workspace-1'
  }
  const enrollment = createEnrollment(workspacePath)
  const attempt = createAttempt(input)
  const node = input.node ?? createNode()
  const store = createInMemoryPipelineStore()
  const baseline = await captureProtectedDigest(target)
  store.recordAttemptBaseline({
    watcherId: attempt.watcherId,
    attemptFingerprint: attempt.fingerprint,
    workspacePath,
    digest: baseline
  })
  const reportPath = issuePipelineReportPath(target, attempt.fingerprint)
  store.recordDispatch({
    watcherId: attempt.watcherId,
    instanceId: input.instanceId ?? 'implement',
    epoch: 0,
    attempt: 0,
    dispatchId: input.dispatchId ?? 'dispatch-1',
    workspaceId: target.workspaceId,
    terminalHandle: 'terminal-1',
    reportPath,
    dispatchedAtMs: 2
  })
  await mkdir(join(workspacePath, '.orca', 'heimdall', 'pipeline', 'reports'), { recursive: true })
  await writeFile(
    reportPath,
    JSON.stringify(
      input.report ?? { nodeId: 'implement', summary: 'Done', outputs: { summary: 'complete' } }
    )
  )
  const reportContext: PipelineAgentReportContext = {
    target,
    node,
    async fileExists(relativePath) {
      try {
        await stat(join(workspacePath, relativePath))
        return true
      } catch {
        return false
      }
    }
  }
  const resolveReportContext = async () => reportContext
  const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [attempt] }
  const adapter = createPipelineSubmissionAdapter({ store, resolveReportContext })
  return { adapter, attempt, enrollment, ledger, reportPath, store, target, workspacePath }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('createPipelineSubmissionAdapter', () => {
  it('accepts a valid worker_done report when protected files remain unchanged', async () => {
    const { adapter, enrollment, ledger, reportPath } = await setup()

    const result = await adapter.preflightWorkerReport(
      { dispatchId: 'dispatch-1', payload: { reportPath } },
      { enrollment, snapshot: null, ledger }
    )

    expect(result).toEqual({ status: 'accepted' })
  })

  it('rejects worker_done with the protected path and report-invalid code when a pipeline file changed', async () => {
    const { adapter, enrollment, ledger, reportPath, workspacePath } = await setup()
    await mkdir(join(workspacePath, '.orca', 'pipelines'), { recursive: true })
    await writeFile(join(workspacePath, '.orca', 'pipelines', 'bugfix.yaml'), 'edited')

    const result = await adapter.preflightWorkerReport(
      { dispatchId: 'dispatch-1', payload: { reportPath } },
      { enrollment, snapshot: null, ledger }
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'heimdall_report_invalid',
      reason: expect.stringContaining('protected-path-modified:.orca/pipelines/bugfix.yaml')
    })
  })

  it('rejects a report path not issued for the active attempt', async () => {
    const { adapter, enrollment, ledger } = await setup()

    const result = await adapter.preflightWorkerReport(
      { dispatchId: 'dispatch-1', payload: { reportPath: '/tmp/forged-report.json' } },
      { enrollment, snapshot: null, ledger }
    )

    expect(result).toMatchObject({ status: 'rejected', code: 'heimdall_report_invalid' })
  })
  it('validates merge conflict reports against the private resolver output schema', async () => {
    const node: PipelineAgentNode = {
      id: 'merge-1',
      type: 'agent',
      prompt: 'Resolve the merge conflict',
      outputs: { resolved: { type: 'boolean' } }
    }
    const { adapter, enrollment, ledger, reportPath } = await setup({
      actionKind: 'pipeline-resolve-merge-conflict',
      fingerprint: 'resolver-fingerprint',
      dispatchId: 'resolver-dispatch',
      instanceId: 'merge-1[task-1]',
      nodeId: 'merge-1',
      node,
      report: {
        nodeId: 'merge-1',
        summary: 'Resolution output has the wrong key',
        outputs: { wrong: true }
      }
    })

    const result = await adapter.preflightWorkerReport(
      { dispatchId: 'resolver-dispatch', payload: { reportPath } },
      { enrollment, snapshot: null, ledger }
    )

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'heimdall_report_invalid',
      reason: expect.stringContaining('wrong')
    })
  })

  it('does not parse a composite sitter submission as an Agent report', async () => {
    const { adapter, enrollment, reportPath, store } = await setup()
    const sitterAttempt: AttemptEntry = {
      ...createAttempt(),
      action: {
        kind: 'hosted-review-dispatch-fix',
        capability: 'fixChecks',
        visibility: 'external',
        contentIdentity: 'sitter:identity',
        evidenceKey: 'sitter-key'
      }
    }
    const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [sitterAttempt] }

    const result = await adapter.preflightWorkerReport(
      { dispatchId: 'dispatch-1', payload: { reportPath } },
      { enrollment, snapshot: null, ledger }
    )

    expect(result).toEqual({ status: 'accepted' })
    expect(store.facts('watcher-1').outputs).toEqual([])
  })
})
