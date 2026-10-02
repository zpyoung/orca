import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import {
  captureProtectedDigest,
  ProtectedDigestUnverifiableError
} from './protected-pipeline-files'
import {
  dispatchAgentNode,
  resolveAgentAttempt,
  type PipelineAgentReportActionKind
} from './agent-node-executor'
import { issuePipelineReportPath, type PipelineWorkspaceTarget } from './pipeline-report-path'

const directories: string[] = []

async function createWorkspace(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'pipeline-agent-'))
  directories.push(workspacePath)
  return workspacePath
}

function createAttempt(fingerprint: string, dispatchId = 'dispatch-1'): AttemptEntry {
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
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      contentIdentity: 'pipeline:sha256:abc',
      evidenceKey: `key-${fingerprint}`,
      pipelineNode: { instanceId: 'implement', nodeId: 'implement', epoch: 0, attempt: 0 }
    },
    state: 'running',
    dispatchId
  }
}

function createTarget(workspacePath: string) {
  return {
    executionHostId: 'local' as const,
    workspaceKind: 'folder' as const,
    workspacePath,
    workspaceId: 'workspace-1'
  }
}

function agentNode(
  outputs: NonNullable<PipelineAgentNode['outputs']> = { summary: { type: 'text' } }
): PipelineAgentNode {
  return { id: 'implement', type: 'agent', harness: 'claude', prompt: 'Implement', outputs }
}

async function saveReport(
  target: PipelineWorkspaceTarget,
  report: unknown,
  attemptFingerprint = 'attempt-fingerprint'
): Promise<void> {
  const reportPath = issuePipelineReportPath(target, attemptFingerprint)
  await mkdir(join(target.workspacePath, '.orca', 'heimdall', 'pipeline', 'reports'), {
    recursive: true
  })
  await writeFile(reportPath, JSON.stringify(report))
}

async function prepareResolution(input: {
  report: unknown
  includeProtectedChange?: boolean
  actionKind?: PipelineAgentReportActionKind
  attemptFingerprint?: string
  dispatchId?: string
  instanceId?: string
  nodeId?: string
  node?: PipelineAgentNode
}) {
  const workspacePath = await createWorkspace()
  const target = createTarget(workspacePath)
  const instanceId = input.instanceId ?? 'implement'
  const nodeId = input.nodeId ?? 'implement'
  const attemptFingerprint = input.attemptFingerprint ?? 'attempt-fingerprint'
  const dispatchId = input.dispatchId ?? 'dispatch-1'
  const node = input.node ?? agentNode()
  const store = createInMemoryPipelineStore()
  const baseAttempt = createAttempt(attemptFingerprint, dispatchId)
  const attempt: AttemptEntry = {
    ...baseAttempt,
    action: {
      ...baseAttempt.action,
      kind: input.actionKind ?? 'pipeline-dispatch-agent',
      pipelineNode: { instanceId, nodeId, epoch: 0, attempt: 0 }
    }
  }
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
    instanceId,
    epoch: 0,
    attempt: 0,
    dispatchId,
    workspaceId: target.workspaceId ?? null,
    terminalHandle: 'terminal-1',
    reportPath,
    dispatchedAtMs: 2
  })
  await saveReport(target, input.report, attempt.fingerprint)
  if (input.includeProtectedChange) {
    await mkdir(join(workspacePath, '.orca', 'pipelines'), { recursive: true })
    await writeFile(join(workspacePath, '.orca', 'pipelines', 'bugfix.yaml'), 'edited')
  }
  const resolveReportContext = async () => ({
    target,
    node,
    async fileExists(relativePath: string) {
      try {
        await stat(join(workspacePath, relativePath))
        return true
      } catch {
        return false
      }
    }
  })
  return { attempt, node, store, target, resolveReportContext }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('dispatchAgentNode', () => {
  it('stores an attempt baseline and dispatch row before returning a landed outcome', async () => {
    const workspacePath = await createWorkspace()
    const target = createTarget(workspacePath)
    const store = createInMemoryPipelineStore()
    const expectedReportPath = issuePipelineReportPath(target, 'dispatch-fingerprint')
    const result = await dispatchAgentNode(
      {
        watcherId: 'watcher-1',
        node: agentNode(),
        instanceId: 'implement',
        epoch: 0,
        attempt: 0,
        attemptFingerprint: 'dispatch-fingerprint',
        renderedPrompt: 'Implement the requested change.',
        harness: 'claude',
        model: 'model-x',
        effort: 'high',
        target
      },
      {
        store,
        nowMs: () => 123,
        async dispatchWorker(request) {
          expect(store.attemptBaseline('watcher-1', 'dispatch-fingerprint')).not.toBeNull()
          expect(request.spec).toContain('## Report instructions')
          expect(request.spec).toContain('worker_done')
          expect(request.spec).toContain(JSON.stringify(expectedReportPath))
          expect(request.spec).toContain('Required output keys in outputs: ["summary"].')
          expect(request.spec).toContain('- "summary": text (JSON string)')
          expect(request.taskKey).toBe('implement')
          return {
            status: 'dispatched',
            dispatchId: 'dispatch-success',
            terminalHandle: 'terminal-1'
          }
        }
      }
    )

    expect(result).toMatchObject({
      effect: 'landed',
      result: {
        dispatchId: 'dispatch-success',
        reportPath: expectedReportPath,
        terminalHandle: 'terminal-1'
      }
    })
    expect(store.attemptBaseline('watcher-1', 'dispatch-fingerprint')).toMatchObject({
      workspacePath,
      digest: { status: 'ok', entries: [] }
    })
    expect(store.facts('watcher-1').dispatches).toEqual([
      expect.objectContaining({
        instanceId: 'implement',
        dispatchId: 'dispatch-success',
        workspaceId: 'workspace-1',
        terminalHandle: 'terminal-1',
        reportPath: expectedReportPath,
        dispatchedAtMs: 123
      })
    ])
  })

  it('classifies refused and thrown dispatches as infrastructure failures and preserves indeterminate', async () => {
    const workspacePath = await createWorkspace()
    const target = createTarget(workspacePath)
    const node = agentNode()
    const store = createInMemoryPipelineStore()
    const input = {
      watcherId: 'watcher-1',
      node,
      instanceId: 'implement',
      epoch: 0,
      attempt: 0,
      attemptFingerprint: 'dispatch-fingerprint',
      renderedPrompt: 'Implement the requested change.',
      harness: 'claude',
      target
    }
    const refused = await dispatchAgentNode(input, {
      store,
      nowMs: () => 123,
      async dispatchWorker() {
        return {
          status: 'refused',
          reason: 'placement-unavailable',
          detail: 'No worker is available.'
        }
      }
    })
    const thrown = await dispatchAgentNode(
      { ...input, attemptFingerprint: 'thrown-fingerprint' },
      {
        store,
        nowMs: () => 123,
        async dispatchWorker() {
          throw new Error('worker launch failed')
        }
      }
    )
    const indeterminate = await dispatchAgentNode(
      { ...input, attemptFingerprint: 'unknown-fingerprint' },
      {
        store,
        nowMs: () => 123,
        async dispatchWorker() {
          return { status: 'indeterminate', requestId: 'request-1' }
        }
      }
    )

    expect(refused).toMatchObject({ effect: 'not-landed', failureClass: 'infra' })
    expect(thrown).toMatchObject({ effect: 'not-landed', failureClass: 'infra' })
    expect(indeterminate).toMatchObject({ effect: 'indeterminate' })
    expect(store.facts('watcher-1').dispatches).toEqual([])
    expect(store.attemptBaseline('watcher-1', 'unknown-fingerprint')).not.toBeNull()
  })

  it('does not dispatch when protected-file baseline capture is unverifiable', async () => {
    const workspacePath = await createWorkspace()
    let dispatchCalled = false
    const result = await dispatchAgentNode(
      {
        watcherId: 'watcher-1',
        node: agentNode(),
        instanceId: 'implement',
        epoch: 0,
        attempt: 0,
        attemptFingerprint: 'unverifiable-fingerprint',
        renderedPrompt: 'Implement the requested change.',
        harness: 'claude',
        target: createTarget(workspacePath)
      },
      {
        store: createInMemoryPipelineStore(),
        nowMs: () => 123,
        captureDigest: async () => {
          throw new ProtectedDigestUnverifiableError('SSH disappeared')
        },
        async dispatchWorker() {
          dispatchCalled = true
          return { status: 'dispatched', dispatchId: 'unreachable' }
        }
      }
    )

    expect(result).toMatchObject({ effect: 'not-landed', failureClass: 'infra' })
    expect(dispatchCalled).toBe(false)
  })
})

describe('resolveAgentAttempt', () => {
  it('lands a valid report only when the protected digest is unchanged and records outputs', async () => {
    const { attempt, store, resolveReportContext } = await prepareResolution({
      report: { nodeId: 'implement', summary: 'Done', outputs: { summary: 'complete' } }
    })

    const result = await resolveAgentAttempt(attempt, {
      store,
      resolveReportContext,
      nowMs: () => 456
    })

    const reportBytes = JSON.stringify({
      nodeId: 'implement',
      summary: 'Done',
      outputs: { summary: 'complete' }
    })
    expect(result).toEqual({ effect: 'landed' })
    expect(store.facts('watcher-1').outputs).toEqual([
      expect.objectContaining({
        instanceId: 'implement',
        epoch: 0,
        attempt: 0,
        outputs: { summary: 'complete' },
        reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
        reportSummary: 'Done'
      })
    ])
  })
  it('resolves merge-conflict reports under their private child instance', async () => {
    const resolver = await prepareResolution({
      report: {
        nodeId: 'merge-1',
        summary: 'Conflicts resolved',
        outputs: { resolved: true }
      },
      actionKind: 'pipeline-resolve-merge-conflict',
      attemptFingerprint: 'resolver-fingerprint',
      dispatchId: 'resolver-dispatch',
      instanceId: 'merge-1[task-1]',
      nodeId: 'merge-1',
      node: {
        id: 'merge-1',
        type: 'agent',
        prompt: 'Resolve the child conflict',
        outputs: { resolved: { type: 'boolean' } }
      }
    })

    const result = await resolveAgentAttempt(resolver.attempt, {
      store: resolver.store,
      resolveReportContext: resolver.resolveReportContext,
      nowMs: () => 789
    })

    expect(result).toEqual({ effect: 'landed' })
    expect(resolver.store.facts('watcher-1').outputs).toEqual([
      expect.objectContaining({
        instanceId: 'merge-1[task-1]',
        outputs: { resolved: true },
        reportSummary: 'Conflicts resolved'
      })
    ])
  })

  it('classifies invalid reports and protected edits as criteria without persisting outputs', async () => {
    const invalid = await prepareResolution({
      report: { nodeId: 'implement', summary: 'Done', outputs: { undeclared: 'value' } }
    })
    const invalidResult = await resolveAgentAttempt(invalid.attempt, {
      store: invalid.store,
      resolveReportContext: invalid.resolveReportContext,
      nowMs: () => 456
    })
    const changed = await prepareResolution({
      report: { nodeId: 'implement', summary: 'Done', outputs: { summary: 'complete' } },
      includeProtectedChange: true
    })
    const changedResult = await resolveAgentAttempt(changed.attempt, {
      store: changed.store,
      resolveReportContext: changed.resolveReportContext,
      nowMs: () => 456
    })

    expect(invalidResult).toMatchObject({ effect: 'not-landed', failureClass: 'criteria' })
    expect(changedResult).toMatchObject({ effect: 'not-landed', failureClass: 'criteria' })
    expect(changedResult.reportValidation?.detail).toContain(
      'protected-path-modified:.orca/pipelines/bugfix.yaml'
    )
    expect(invalid.store.facts('watcher-1').outputs).toEqual([])
    expect(changed.store.facts('watcher-1').outputs).toEqual([])
  })

  it('keeps an unverifiable protected digest indeterminate rather than changed', async () => {
    const context = await prepareResolution({
      report: { nodeId: 'implement', summary: 'Done', outputs: { summary: 'complete' } }
    })

    const result = await resolveAgentAttempt(context.attempt, {
      store: context.store,
      resolveReportContext: context.resolveReportContext,
      nowMs: () => 456,
      captureDigest: async () => {
        throw new ProtectedDigestUnverifiableError('remote workspace unavailable')
      }
    })

    expect(result).toEqual({ effect: 'indeterminate' })
    expect(context.store.facts('watcher-1').outputs).toEqual([])
  })
})
