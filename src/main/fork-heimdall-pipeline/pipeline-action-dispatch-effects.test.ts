import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { EnrollResult, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import { buildPipelineAction } from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import {
  buildPipelineCheckAction,
  buildPipelineScriptAction
} from '../../shared/fork-heimdall-pipeline/interpreter/decision-prompts'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { createPipelineActionDispatcher } from './pipeline-action-dispatch'
import {
  createPipelineKindTestHarness,
  type PipelineKindTestHarness
} from './pipeline-kind-test-harness'
import { createHostedReviewKind } from '../fork-hosted-review-sitter/kind'
import { createSitterCompositeAdapters } from './sitter-composite'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { landExpectedState, readPipelineLandingFacts } from './land-node-executor'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'

vi.mock('electron', () => ({}))

const CHECK_SOURCE = `version: 1
id: dispatch-check
name: Dispatch check
nodes:
  - id: check
    type: check
    command: test -f README.txt
`

const SCRIPT_SOURCE = `version: 1
id: dispatch-script
name: Dispatch script
nodes:
  - id: script
    type: script
    capability: script
    command: printf 'written' > dispatcher-script-result.txt
`

const AGENT_FILE_OUTPUT_SOURCE = `version: 1
id: dispatch-agent-file
name: Dispatch agent file
nodes:
  - id: agent
    type: agent
    harness: claude
    prompt: Write a file output.
    outputs:
      artifact:
        type: file
`

const LAND_SOURCE = `version: 1
id: dispatch-land
name: Dispatch land
nodes:
  - id: land
    type: land
`

const lease: LeaseGuard = {
  epoch: 1,
  holder: 'pipeline-action-dispatch-test',
  assertHeld: async () => undefined,
  renewLoop: () => ({ dispose: () => undefined })
}

const forge: ObjectiveForgeAccess = {
  detectProvider: async () => 'unsupported',
  getProvider: async () => null,
  getDefaultBranch: async () => null,
  isAuthenticated: async () => false,
  invalidate: () => undefined
}

const harnesses: PipelineKindTestHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

async function createHarness(): Promise<PipelineKindTestHarness> {
  const harness = await createPipelineKindTestHarness()
  harnesses.push(harness)
  return harness
}

function enrolled(result: EnrollResult): WatcherEnrollment {
  if (result.status !== 'enrolled') {
    throw new Error(`Expected a pipeline enrollment, got ${JSON.stringify(result)}`)
  }
  return result.entry.enrollment
}

function readyWorld(
  harness: PipelineKindTestHarness,
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger = harness.service.ledger(enrollment.watcherId)
): PipelineReadyWorld {
  const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
  return {
    watcherId: enrollment.watcherId,
    enrollment,
    payload,
    facts: harness.pipelineStore.facts(enrollment.watcherId),
    ledger,
    nowMs: 30_000,
    hasOwner: enrollment.owner !== undefined,
    grants: enrollment.capabilities,
    workspacePath: enrollment.workspacePath,
    unverifiableDispatchIds: new Set(),
    composites: {},
    compositeReadErrors: {}
  }
}

function snapshot(world: PipelineReadyWorld) {
  return {
    freshness: 'live' as const,
    contentIdentity: `pipeline:${world.payload.pin.contentHash}`,
    observedAtMs: world.nowMs,
    world
  }
}

function dispatcherFor(harness: PipelineKindTestHarness) {
  const hostedReviewKind = createHostedReviewKind(harness.runtime, harness.store, 'desktop')
  const sitterAdapters = createSitterCompositeAdapters({
    runtime: harness.runtime,
    store: harness.store,
    pipelineStore: harness.pipelineStore,
    hostedReviewKind,
    storageAuthority: 'desktop'
  })
  return createPipelineActionDispatcher({
    runtime: harness.runtime,
    store: harness.store,
    pipelineStore: harness.pipelineStore,
    nowMs: () => 30_000,
    forge,
    compositeActions: sitterAdapters.compositeActions
  })
}

function executionContext(world: PipelineReadyWorld): ExecuteContext<PipelineReadyWorld> {
  return {
    snapshot: snapshot(world),
    lease,
    ledger: world.ledger,
    dispatchWorker: async () => ({
      status: 'refused',
      reason: 'pre-dispatch-failure',
      detail: 'unused'
    })
  }
}

function attempt(
  action: KernelAction,
  watcherId: string,
  overrides: Partial<AttemptEntry> = {}
): AttemptEntry {
  return {
    eventId: `${action.kind}-attempt-event`,
    watcherId,
    atMs: 30_000,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `${action.kind}-attempt`,
    fingerprint: makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey),
    action,
    state: 'running',
    ...overrides
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, admissionTier: 'background' })).stdout.trim()
}

describe('pipeline action effects', () => {
  it('runs real Check and Script effects and rejects a stale node identity before execution', async () => {
    const checkHarness = await createHarness()
    const checkEnrollment = enrolled(
      await checkHarness.enroll(CHECK_SOURCE, { runInputs: { task: 'run the check' } })
    )
    const checkWorld = readyWorld(checkHarness, checkEnrollment)
    const checkNode = checkWorld.payload.document.nodes.find((node) => node.type === 'check')
    if (checkNode?.type !== 'check') {
      throw new Error('Expected the Check node')
    }
    const dispatcher = dispatcherFor(checkHarness)
    const check = buildPipelineCheckAction(checkWorld, checkNode, 0, 0)
    const passed = await dispatcher.execute(check, executionContext(checkWorld))

    expect(passed).toMatchObject({ effect: 'landed', result: { passed: true, exitCode: 0 } })

    const staleCheck = buildPipelineAction({
      kind: 'pipeline-run-check',
      capability: 'check',
      visibility: 'local',
      pin: checkWorld.payload.pin,
      instanceId: 'check',
      nodeId: 'check',
      epoch: 1,
      attempt: 0,
      fields: { command: 'touch stale-check-ran', timeoutSeconds: 30 }
    })
    await expect(
      dispatcher.execute(staleCheck, executionContext(checkWorld))
    ).resolves.toMatchObject({
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: 'pipeline-action-identity-stale'
    })
    await expect(
      readFile(join(checkHarness.workspacePath, 'stale-check-ran'), 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const scriptHarness = await createHarness()
    const scriptEnrollment = enrolled(
      await scriptHarness.enroll(SCRIPT_SOURCE, { runInputs: { task: 'run the script' } })
    )
    const scriptWorld = readyWorld(scriptHarness, scriptEnrollment)
    const scriptNode = scriptWorld.payload.document.nodes.find((node) => node.type === 'script')
    if (scriptNode?.type !== 'script') {
      throw new Error('Expected the Script node')
    }
    const script = buildPipelineScriptAction({
      world: scriptWorld,
      node: scriptNode,
      epoch: 0,
      attempt: 0,
      outputs: {}
    })
    if (script === null) {
      throw new Error('Expected a rendered Script action')
    }
    const scriptResult = await dispatcherFor(scriptHarness).execute(
      script,
      executionContext(scriptWorld)
    )

    expect(scriptResult).toMatchObject({ effect: 'landed', result: { passed: true } })
    await expect(
      readFile(join(scriptHarness.workspacePath, 'dispatcher-script-result.txt'), 'utf8')
    ).resolves.toBe('written')
  })

  it('accepts only report files within the dispatched workspace', async () => {
    const harness = await createHarness()
    const enrollment = enrolled(
      await harness.enroll(AGENT_FILE_OUTPUT_SOURCE, {
        runInputs: { task: 'write the file output' }
      })
    )
    const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
    const action = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      pin: payload.pin,
      instanceId: 'agent',
      nodeId: 'agent',
      epoch: 0,
      attempt: 0,
      fields: { agent: 'claude', spec: 'Write dispatcher-artifact.txt.' }
    })
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const digest = { status: 'ok', entries: [] } as const
    harness.pipelineStore.recordAttemptBaseline({
      watcherId: enrollment.watcherId,
      attemptFingerprint: fingerprint,
      workspacePath: enrollment.workspacePath,
      digest
    })
    harness.pipelineStore.recordDispatch({
      watcherId: enrollment.watcherId,
      instanceId: 'agent',
      epoch: 0,
      attempt: 0,
      dispatchId: 'agent-dispatch-for-file-output',
      workspaceId: enrollment.worktreeId,
      terminalHandle: 'agent-terminal',
      reportPath: '/unused/report.json',
      dispatchedAtMs: 1
    })
    await writeFile(join(harness.workspacePath, 'dispatcher-artifact.txt'), 'real file\n')
    await mkdir(join(harness.workspacePath, 'dispatcher-directory'))
    const reportAttempt = attempt(action, enrollment.watcherId)
    const facts = harness.pipelineStore.facts(enrollment.watcherId)
    const dispatch = facts.dispatches.find(
      (candidate) => candidate.dispatchId === 'agent-dispatch-for-file-output'
    )
    const baseline = harness.pipelineStore.attemptBaseline(enrollment.watcherId, fingerprint)
    if (dispatch === undefined || baseline === null) {
      throw new Error('Expected persisted report authority facts')
    }

    const context = await dispatcherFor(harness).resolveReportContext({
      enrollment,
      attempt: reportAttempt,
      dispatch,
      baseline
    })

    await expect(context.fileExists('dispatcher-artifact.txt')).resolves.toBe(true)
    await expect(context.fileExists('dispatcher-directory')).resolves.toBe(false)
    await expect(context.fileExists('../dispatcher-artifact.txt')).resolves.toBe(false)
  })

  it('recovers Land push only from the captured remote ref and reports an unreachable remote as indeterminate', async () => {
    const harness = await createHarness()
    const enrollment = enrolled(
      await harness.enroll(LAND_SOURCE, {
        runInputs: { task: 'land the test change' },
        capabilities: {
          agent: 'on',
          check: 'on',
          script: 'on',
          integrate: 'on',
          push: 'on',
          land: 'on'
        }
      })
    )
    const remotePath = join(harness.root, 'land-origin.git')
    await git(harness.root, ['init', '--bare', remotePath])
    await git(harness.workspacePath, ['remote', 'add', 'origin', remotePath])
    await git(harness.workspacePath, ['push', '-u', 'origin', 'main'])
    const before = await git(remotePath, ['rev-parse', 'refs/heads/main'])
    await writeFile(join(harness.workspacePath, 'landed.txt'), 'landed\n')
    await git(harness.workspacePath, ['add', 'landed.txt'])
    await git(harness.workspacePath, ['commit', '-m', 'land dispatcher test'])

    const target = await resolveObjectiveWorkspaceTarget(harness.runtime, enrollment)
    const landingFacts = await readPipelineLandingFacts({
      target,
      repoKey: enrollment.repoId,
      forge
    })
    const pushTarget = landingFacts.pushTarget
    const headSha = landingFacts.headSha
    if (landingFacts.branch === null || pushTarget === null || headSha === null) {
      throw new Error('Expected authoritative Land push facts')
    }
    expect(pushTarget.remoteSha).toBe(before)
    const expectedState = landExpectedState('pipeline-land-push', {
      ...landingFacts,
      branch: pushTarget.branch,
      headSha,
      target: pushTarget
    })
    const action = buildPipelineAction({
      kind: 'pipeline-land-push',
      capability: 'push',
      visibility: 'external',
      pin: PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload).pin,
      instanceId: 'land',
      nodeId: 'land',
      epoch: 0,
      attempt: 0,
      step: JSON.stringify([
        'pipeline-land-push',
        landingFacts.branch,
        pushTarget.remote,
        pushTarget.branch,
        headSha,
        pushTarget.remoteSha
      ]),
      fields: {
        branch: pushTarget.branch,
        headSha,
        target: pushTarget,
        expectedState
      }
    })
    const expectation = {
      expectedBefore: pushTarget.remoteSha,
      expectedAfter: headSha
    }
    const pendingAttempt = attempt(action, enrollment.watcherId, expectation)
    const ledger: WatcherLedger = { watcherId: enrollment.watcherId, entries: [pendingAttempt] }
    const world = {
      ...readyWorld(harness, enrollment, ledger),
      landingFacts
    }
    const live = snapshot(world)
    const dispatcher = dispatcherFor(harness)

    await expect(dispatcher.resolveOutcome(pendingAttempt, live, ledger, lease)).resolves.toEqual({
      effect: 'not-landed'
    })

    await git(harness.workspacePath, [
      'remote',
      'set-url',
      'origin',
      join(harness.root, 'missing-origin.git')
    ])
    await expect(
      dispatcher.resolveOutcome(pendingAttempt, live, ledger, lease)
    ).resolves.toMatchObject({
      effect: 'indeterminate',
      failureClass: 'infra'
    })

    await git(harness.workspacePath, ['remote', 'set-url', 'origin', remotePath])
    const executed = await dispatcher.execute(action, {
      snapshot: live,
      lease,
      ledger,
      dispatchWorker: async () => ({
        status: 'refused',
        reason: 'pre-dispatch-failure',
        detail: 'unused'
      })
    })
    expect(executed).toMatchObject({ effect: 'landed' })
    expect(await git(remotePath, ['rev-parse', 'refs/heads/main'])).toBe(headSha)
    await expect(dispatcher.resolveOutcome(pendingAttempt, live, ledger, lease)).resolves.toEqual({
      effect: 'landed'
    })
  })
})
