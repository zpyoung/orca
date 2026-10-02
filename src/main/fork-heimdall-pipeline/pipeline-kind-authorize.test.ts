import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NodeType } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { EnrollResult } from '../../shared/fork-heimdall/watcher-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  createPipelineKindTestHarness,
  pipelineEnrollmentInput,
  PIPELINE_AGENT_SOURCE,
  type PipelineKindTestHarness
} from './pipeline-kind-test-harness'

vi.mock('electron', () => ({}))

const harnesses: PipelineKindTestHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

async function createHarness(
  options: Parameters<typeof createPipelineKindTestHarness>[0] = {}
): Promise<PipelineKindTestHarness> {
  const harness = await createPipelineKindTestHarness(options)
  harnesses.push(harness)
  return harness
}

function enrolled(result: EnrollResult) {
  if (result.status !== 'enrolled') {
    throw new Error(`Expected a new pipeline enrollment; got ${JSON.stringify(result)}`)
  }
  return result.entry.enrollment
}

function sourcePin(sourceText: string) {
  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw new Error('Pipeline authorization test source did not parse')
  }
  return {
    ref: parsed.document.id,
    scope: 'repo' as const,
    id: parsed.document.id,
    contentHash: pipelineContentHash(parsed.document),
    documentVersion: parsed.document.version
  }
}

describe('custom pipeline kernel authorization', () => {
  it('derives persisted workspace and grants from a source-pinned pipeline request', async () => {
    const harness = await createHarness()
    const result = await harness.enroll(PIPELINE_AGENT_SOURCE, {
      runInputs: { task: 'repair the missing null check' },
      capabilities: { agent: 'on', integrate: 'off' }
    })
    const enrollment = enrolled(result)
    const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)

    expect(enrollment).toMatchObject({
      kind: 'pipeline',
      executionHostId: 'local',
      repoId: harness.repoId,
      worktreeId: harness.worktreeId,
      workspacePath: harness.workspacePath,
      workspaceKey: `local::${harness.workspacePath}`,
      schedulerOwner: 'local_host_service',
      capabilities: {
        agent: 'on',
        integrate: 'off',
        gate: 'on',
        pipeline: 'on'
      }
    })
    expect(payload).toMatchObject({
      schemaVersion: 1,
      pin: sourcePin(PIPELINE_AGENT_SOURCE),
      sourceText: PIPELINE_AGENT_SOURCE,
      runInputs: { task: 'repair the missing null check' },
      workspaceKind: 'git'
    })
    expect(payload.document.nodes).toEqual([
      expect.objectContaining({ id: 'fix', type: 'agent', harness: 'claude' })
    ])
    expect(harness.pipelineStore.runPin(enrollment.watcherId)).toMatchObject({
      ...sourcePin(PIPELINE_AGENT_SOURCE),
      runNumber: 1
    })
    expect(harness.pipelineStore.runSource(enrollment.watcherId)).toEqual({
      sourceText: PIPELINE_AGENT_SOURCE
    })
  })

  it('refuses a pin whose content hash does not identify the supplied document source', async () => {
    const harness = await createHarness()
    const validPin = sourcePin(PIPELINE_AGENT_SOURCE)
    const result = await harness.service.enroll(
      pipelineEnrollmentInput(harness, PIPELINE_AGENT_SOURCE, {
        pin: { ...validPin, contentHash: `sha256:${'0'.repeat(64)}` }
      })
    )

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(harness.enrollmentStore.list()).toEqual([])
    expect(
      harness.pipelineDatabase
        .connection()
        .prepare('SELECT COUNT(*) AS count FROM pipeline_run_pin')
        .get()?.count
    ).toBe(0)
  })

  it.each([
    ['engine gate grant', { agent: 'on', gate: 'off' }],
    ['engine pipeline grant', { agent: 'on', pipeline: 'off' }],
    ['unknown grant', { agent: 'on', dangerous: 'on' }]
  ] as const)('rejects client-controlled %s', async (_name, capabilities) => {
    const harness = await createHarness()
    const result = await harness.service.enroll(
      pipelineEnrollmentInput(harness, PIPELINE_AGENT_SOURCE, { capabilities })
    )

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(harness.enrollmentStore.list()).toEqual([])
  })

  it('resolves the named workspace through runtime authority instead of trusting a candidate path', async () => {
    const harness = await createHarness()
    const result = await harness.service.enroll(
      pipelineEnrollmentInput(harness, PIPELINE_AGENT_SOURCE, {
        worktreeId: `${harness.repoId}::${harness.workspacePath}/unregistered`
      })
    )

    expect(result).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(harness.enrollmentStore.list()).toEqual([])
  })

  it('authorizes a real folder workspace without turning it into a Git worktree', async () => {
    const harness = await createHarness({ workspaceKind: 'folder' })
    const enrollment = enrolled(await harness.enroll())
    const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)

    expect(enrollment).toMatchObject({
      executionHostId: 'local',
      worktreeId: null,
      workspacePath: harness.workspacePath,
      workspaceKey: `local::${harness.workspacePath}`
    })
    expect(payload.workspaceKind).toBe('folder')
  })

  it('refuses runtime-owned worktree creation on a host that this desktop cannot execute', async () => {
    const harness = await createHarness({ repoExecutionHostId: 'runtime:test-host' })
    const result = await harness.enroll(PIPELINE_AGENT_SOURCE, {
      worktreeId: null,
      newWorktree: { name: 'pipeline-run' }
    })

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'owner-not-executable',
      schedulerOwner: 'remote_host_service'
    })
    expect(harness.enrollmentStore.list()).toEqual([])
  })
  it('binds the runtime scheduler owner to its actual local Git authority', async () => {
    const harness = await createHarness({ storageAuthority: 'runtime' })
    const enrollment = enrolled(await harness.enroll())

    expect(enrollment).toMatchObject({
      executionHostId: 'local',
      schedulerOwner: 'remote_host_service',
      workspaceKey: `local::${harness.workspacePath}`,
      workspacePath: harness.workspacePath,
      worktreeId: harness.worktreeId
    })
  })
  it('creates a new Git worktree with its enrollment comment and matching host authority', async () => {
    const harness = await createHarness()
    const enrollment = enrolled(
      await harness.enroll(PIPELINE_AGENT_SOURCE, {
        worktreeId: null,
        newWorktree: { name: 'pipeline-enrollment-child', baseBranch: 'main' }
      })
    )
    if (enrollment.worktreeId === null) {
      throw new Error('A new Pipeline worktree did not produce a worktree identity')
    }
    const target = await harness.resolveGitTarget(enrollment.worktreeId)

    expect(enrollment).toMatchObject({
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      worktreeId: target.worktree.id,
      workspacePath: target.worktree.path,
      workspaceKey: `local::${target.worktree.path}`
    })
    expect(target).toMatchObject({
      executionHostId: enrollment.executionHostId,
      worktree: {
        repoId: harness.repoId,
        isMainWorktree: false,
        comment: 'Pipeline enrollment: pipeline-enrollment-child'
      }
    })
    expect(await harness.gitWorktreePaths()).toContain(target.worktree.path)
  })

  it('removes a real newly-created Git worktree when host node validation refuses the Pipeline', async () => {
    const harness = await createHarness({ hostNodeTypes: new Set<NodeType>(['check']) })
    const originalPaths = await harness.gitWorktreePaths()
    const result = await harness.service.enroll(
      pipelineEnrollmentInput(harness, PIPELINE_AGENT_SOURCE, {
        worktreeId: null,
        newWorktree: { name: 'pipeline-host-refusal', baseBranch: 'main' }
      })
    )

    expect(result).toMatchObject({
      status: 'refused',
      reason: 'invalid-payload'
    })
    expect(harness.enrollmentStore.list()).toEqual([])
    expect(harness.createdWorktreePaths).toHaveLength(1)
    expect(await harness.gitWorktreePaths()).not.toContain(harness.createdWorktreePaths[0])
    expect(await harness.gitWorktreePaths()).toEqual(originalPaths)
    expect(
      harness.pipelineDatabase
        .connection()
        .prepare('SELECT COUNT(*) AS count FROM pipeline_run_pin')
        .get()?.count
    ).toBe(0)
  })

  it('keeps the source and pin immutable when re-arming a custom pipeline', async () => {
    const harness = await createHarness()
    const first = enrolled(await harness.enroll(PIPELINE_AGENT_SOURCE))
    const originalPin = harness.pipelineStore.runPin(first.watcherId)
    const originalSource = harness.pipelineStore.runSource(first.watcherId)

    await expect(harness.command(first.watcherId, { kind: 'disarm' })).resolves.toMatchObject({
      status: 'applied'
    })
    const editedSource = PIPELINE_AGENT_SOURCE.replace(
      'Fix the reported bug:',
      'Change the reported bug:'
    )
    const changed = await harness.service.enroll(pipelineEnrollmentInput(harness, editedSource))
    expect(changed).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const rearmed = await harness.enroll(PIPELINE_AGENT_SOURCE)
    expect(rearmed).toMatchObject({ status: 're-armed' })
    if (rearmed.status !== 're-armed') {
      throw new Error('Expected the original pipeline to re-arm')
    }
    const persisted = PipelineEnrollmentPayloadSchema.parse(rearmed.entry.enrollment.kindPayload)
    expect(persisted).toMatchObject({
      pin: sourcePin(PIPELINE_AGENT_SOURCE),
      sourceText: PIPELINE_AGENT_SOURCE
    })
    expect(harness.pipelineStore.runPin(first.watcherId)).toEqual(originalPin)
    expect(harness.pipelineStore.runSource(first.watcherId)).toEqual(originalSource)
  })

  it('refuses a second live enrollment for the same authoritative workspace', async () => {
    const harness = await createHarness()
    const first = enrolled(await harness.enroll())
    const duplicate = await harness.enroll()

    expect(duplicate).toMatchObject({
      status: 'refused',
      reason: 'duplicate-workspace',
      existingWatcherId: first.watcherId
    })
    expect(harness.enrollmentStore.list()).toHaveLength(1)
  })
})
