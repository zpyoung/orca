import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import type { PipelineLandingFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import type { PipelineActionDispatcherDependencies } from './pipeline-action-dispatch-contracts'
import {
  executeLandCommit,
  executeLandOpenReview,
  executeLandPush,
  landExpectedState,
  readPipelineLandingFacts,
  recoverLandCommit,
  recoverLandOpenReview,
  recoverLandPush,
  LandNodeActionError
} from './land-node-executor'
import type { ObjectivePushTarget } from '../fork-heimdall-objective/landing-git-state'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { assertRunWorkspace } from './pipeline-action-dispatch-workspace'
import { currentIdentityMatches, errorText, record, text } from './pipeline-action-identity'

export type PipelineLandExpectedState = Readonly<{ target: string; before: string }>

function expectedState(action: KernelAction): { target: string; before: string } | null {
  const value = record(action.expectedState)
  return value !== null && typeof value.target === 'string' && typeof value.before === 'string'
    ? { target: value.target, before: value.before }
    : null
}

function pushTarget(action: KernelAction): ObjectivePushTarget | null {
  const value = record(action.target)
  return value !== null &&
    typeof value.remote === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.remoteSha === 'string'
    ? { remote: value.remote, branch: value.branch, remoteSha: value.remoteSha }
    : null
}

export function expectedPipelineLandState(
  action: KernelAction,
  observed: PipelineLandingFacts,
  allowPushAfterState = false
): PipelineLandExpectedState | null {
  const target = pushTarget(action)
  const headSha = text(action, 'headSha')
  const branch = text(action, 'branch')
  const expected = expectedState(action)
  if (
    target === null ||
    headSha === null ||
    branch === null ||
    expected === null ||
    observed.headSha !== headSha ||
    observed.pushTarget === null ||
    observed.pushTarget.remote !== target.remote ||
    observed.pushTarget.branch !== target.branch
  ) {
    return null
  }
  let step: unknown
  try {
    step = JSON.parse(parseStep(action) ?? '')
  } catch {
    return null
  }
  if (action.kind === 'pipeline-land-push') {
    const remoteMatchesExpected =
      observed.pushTarget.remoteSha === target.remoteSha ||
      (allowPushAfterState && observed.pushTarget.remoteSha === headSha)
    if (
      !remoteMatchesExpected ||
      observed.branch === null ||
      branch !== target.branch ||
      !Array.isArray(step) ||
      step.length !== 6 ||
      step[0] !== action.kind ||
      step[1] !== observed.branch ||
      step[2] !== target.remote ||
      step[3] !== target.branch ||
      step[4] !== headSha ||
      step[5] !== target.remoteSha
    ) {
      return null
    }
    return landExpectedState('pipeline-land-push', { ...observed, branch, headSha, target })
  }
  if (observed.pushTarget.remoteSha !== target.remoteSha) {
    return null
  }
  const provider = action.provider
  const base = action.base
  const title = action.title
  const body = action.body
  const draft = action.draft
  if (
    observed.hostedReview === null ||
    (provider !== 'github' && provider !== 'gitlab') ||
    typeof base !== 'string' ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    typeof draft !== 'boolean' ||
    observed.hostedReview.provider !== provider ||
    observed.hostedReview.base !== base ||
    observed.hostedReview.repoKey !== action.repoKey ||
    branch !== target.branch ||
    !Array.isArray(step) ||
    step.length !== 11 ||
    step[0] !== action.kind ||
    step[1] !== observed.branch ||
    step[2] !== provider ||
    step[3] !== observed.hostedReview.repoKey ||
    step[4] !== target.remote ||
    step[5] !== branch ||
    step[6] !== headSha ||
    step[7] !== base ||
    step[8] !== title ||
    step[9] !== body ||
    step[10] !== draft
  ) {
    return null
  }
  return landExpectedState('pipeline-land-open-review', {
    ...observed,
    branch,
    headSha,
    target,
    provider,
    base,
    title,
    body,
    draft
  })
}

function parseStep(action: KernelAction): string | undefined {
  const decoded = action.evidenceKey
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return undefined
  }
  return Array.isArray(parsed) &&
    parsed[0] === 'node' &&
    typeof parsed[4] === 'string' &&
    parsed[4].startsWith('step:')
    ? parsed[4].slice('step:'.length)
    : undefined
}

export function pipelineLandActionIsFresh(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): boolean {
  const identity = currentIdentityMatches(action, world, ledger)
  return (
    identity !== null &&
    action.kind.startsWith('pipeline-land-') &&
    action.capability === (action.kind === 'pipeline-land-push' ? 'push' : 'land')
  )
}

export async function executePipelineLandAction(
  action: KernelAction,
  context: ExecuteContext<PipelineKindWorld>,
  world: PipelineReadyWorld,
  dependencies: PipelineActionDispatcherDependencies
): Promise<ActionOutcome> {
  if (action.kind === 'pipeline-land-commit') {
    const message = text(action, 'message')
    if (message === null || action.capability !== 'land') {
      return { effect: 'not-landed', failureClass: 'criteria', reason: 'land-action-invalid' }
    }
    try {
      await context.lease.assertHeld()
      const target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
      assertRunWorkspace(world, target)
      const result = await executeLandCommit(
        {
          workspacePath: target.workspacePath,
          attemptFingerprint: makeAttemptFingerprint(
            action.contentIdentity,
            action.kind,
            action.evidenceKey
          ),
          message
        },
        { target, forge: dependencies.forge, assertLeaseHeld: () => context.lease.assertHeld() }
      )
      return { effect: 'landed', result }
    } catch (error) {
      if (error instanceof LandNodeActionError) {
        return error.outcome
      }
      return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
    }
  }
  if (action.kind !== 'pipeline-land-push' && action.kind !== 'pipeline-land-open-review') {
    return { effect: 'not-landed', failureClass: 'criteria', reason: 'land-action-invalid' }
  }
  if (!pipelineLandActionIsFresh(action, world, context.ledger)) {
    return { effect: 'not-landed', failureClass: 'criteria', reason: 'land-action-identity-stale' }
  }
  try {
    await context.lease.assertHeld()
    const target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
    assertRunWorkspace(world, target)
    const observed = await readPipelineLandingFacts({
      target,
      repoKey: world.enrollment.repoId,
      forge: dependencies.forge
    })
    const captured = expectedPipelineLandState(action, observed)
    const expected = expectedState(action)
    if (
      captured === null ||
      expected === null ||
      captured.target !== expected.target ||
      captured.before !== expected.before
    ) {
      return { effect: 'not-landed', failureClass: 'criteria', reason: 'landing-evidence-stale' }
    }
    const targetInfo = pushTarget(action)
    const branch = text(action, 'branch')
    const headSha = text(action, 'headSha')
    if (targetInfo === null || branch === null || headSha === null) {
      return { effect: 'not-landed', failureClass: 'criteria', reason: 'land-action-invalid' }
    }
    if (action.kind === 'pipeline-land-push') {
      const result = await executeLandPush(
        { workspacePath: target.workspacePath, branch, headSha, target: targetInfo },
        {
          target,
          forge: dependencies.forge,
          assertLeaseHeld: () => context.lease.assertHeld()
        }
      )
      return { effect: 'landed', result }
    }
    const provider = action.provider
    const base = action.base
    if (
      (provider !== 'github' && provider !== 'gitlab') ||
      typeof base !== 'string' ||
      typeof action.title !== 'string' ||
      typeof action.body !== 'string' ||
      typeof action.draft !== 'boolean'
    ) {
      return { effect: 'not-landed', failureClass: 'criteria', reason: 'land-action-invalid' }
    }
    const result = await executeLandOpenReview(
      {
        workspacePath: target.workspacePath,
        branch,
        title: action.title,
        body: action.body,
        draft: action.draft
      },
      {
        target,
        forge: dependencies.forge,
        headSha,
        pushTarget: targetInfo,
        provider,
        base,
        assertLeaseHeld: () => context.lease.assertHeld()
      }
    )
    return { effect: 'landed', result }
  } catch (error) {
    if (error instanceof LandNodeActionError) {
      return error.outcome
    }
    return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
  }
}

export async function resolvePipelineLandOutcome(
  attempt: AttemptEntry,
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger,
  lease: LeaseGuard,
  dependencies: PipelineActionDispatcherDependencies
): Promise<EffectCertaintyResolution> {
  if (!pipelineLandActionIsFresh(action, world, ledger)) {
    return { effect: 'indeterminate' }
  }
  if (action.kind === 'pipeline-land-commit') {
    try {
      await lease.assertHeld()
      const target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
      assertRunWorkspace(world, target)
      const result = await recoverLandCommit(
        {
          workspacePath: target.workspacePath,
          attemptFingerprint: attempt.fingerprint
        },
        { target, forge: dependencies.forge }
      )
      return result.landed ? { effect: 'landed' } : { effect: 'not-landed' }
    } catch {
      return { effect: 'indeterminate', failureClass: 'infra' }
    }
  }
  if (action.kind !== 'pipeline-land-push' && action.kind !== 'pipeline-land-open-review') {
    return { effect: 'indeterminate' }
  }
  try {
    await lease.assertHeld()
    const target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
    assertRunWorkspace(world, target)
    const observed = await readPipelineLandingFacts({
      target,
      repoKey: world.enrollment.repoId,
      forge: dependencies.forge
    })
    const captured = expectedPipelineLandState(action, observed, true)
    const expected = expectedState(action)
    const expectedAfter = text(action, 'headSha')
    if (
      captured === null ||
      expected === null ||
      expectedAfter === null ||
      captured.target !== expected.target ||
      captured.before !== expected.before ||
      attempt.expectedBefore !== expected.before ||
      attempt.expectedAfter !== expectedAfter
    ) {
      return { effect: 'indeterminate' }
    }
    const targetInfo = pushTarget(action)
    const branch = text(action, 'branch')
    if (targetInfo === null || branch === null) {
      return { effect: 'indeterminate' }
    }
    if (action.kind === 'pipeline-land-push') {
      return {
        effect: await recoverLandPush(
          {
            workspacePath: target.workspacePath,
            branch,
            headSha: expectedAfter,
            target: targetInfo
          },
          {
            target,
            forge: dependencies.forge
          }
        )
      }
    }
    const provider = action.provider
    const base = action.base
    if (
      (provider !== 'github' && provider !== 'gitlab') ||
      typeof base !== 'string' ||
      typeof action.title !== 'string' ||
      typeof action.body !== 'string' ||
      typeof action.draft !== 'boolean'
    ) {
      return { effect: 'indeterminate' }
    }
    return {
      effect: await recoverLandOpenReview(
        { workspacePath: target.workspacePath, branch },
        {
          target,
          forge: dependencies.forge,
          headSha: expectedAfter,
          pushTarget: targetInfo,
          provider,
          base
        }
      )
    }
  } catch {
    return { effect: 'indeterminate', failureClass: 'infra' }
  }
}

export function pipelineLandAttemptExpectation(action: KernelAction):
  | {
      expectedBefore: string
      expectedAfter: string
    }
  | undefined {
  if (action.kind !== 'pipeline-land-push' && action.kind !== 'pipeline-land-open-review') {
    return undefined
  }
  const expected = expectedState(action)
  const headSha = text(action, 'headSha')
  return expected === null || headSha === null
    ? undefined
    : { expectedBefore: expected.before, expectedAfter: headSha }
}

export function pipelineLandPreflight(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): string | null {
  if (!action.kind.startsWith('pipeline-land-')) {
    return null
  }
  if (!pipelineLandActionIsFresh(action, world, ledger)) {
    return 'Pipeline Land action identity changed.'
  }
  if (action.kind !== 'pipeline-land-push' && action.kind !== 'pipeline-land-open-review') {
    return null
  }
  const current =
    world.landingFacts === undefined ? null : expectedPipelineLandState(action, world.landingFacts)
  const expected = expectedState(action)
  return current !== null &&
    expected !== null &&
    current.target === expected.target &&
    current.before === expected.before
    ? null
    : 'Pipeline Land evidence changed.'
}
