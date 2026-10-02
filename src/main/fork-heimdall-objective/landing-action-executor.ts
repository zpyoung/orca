import type { ActionOutcome } from '../../shared/fork-heimdall/effect-certainty'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import {
  objectiveActionNaturalKey,
  type CommitLocalBranchAction,
  type OpenHostedReviewAction,
  type PushRefAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { renderReviewBody } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import { reachedRungs } from '../../shared/fork-heimdall-objective/landing-ladder'
import { computeWorkspaceContentIdentity, objectiveGitCommandForTarget } from './content-identity'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { objectiveForgeContext, type ObjectiveForgeAccess } from './objective-forge-access'
import type { ForgeProvider } from '../source-control/forge-provider'
import {
  executeLandingPushCore,
  executeLandingReviewCore,
  landingErrorOutput
} from './landing-push-review-core'
import { readObjectiveAttachedBranch, readObjectiveHeadSha } from './landing-git-state'
import {
  observeCommittedLocalBranch,
  type CommittedLocalBranchObservation
} from './landing-recovery'
import { objectiveDirtyPathsByTerritory } from './landing-territory'
import type { ObjectiveStore } from './objective-store'
import type { RecordLandingArgs } from './objective-store-data'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

const ATTEMPT_TRAILER = 'Orca-Heimdall-Attempt'

type LandingExecutorArgs<TAction> = {
  action: TAction
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  forge: ObjectiveForgeAccess
}

function invalid(reason: string, result?: unknown): ActionOutcome {
  return { effect: 'not-landed', reason, ...(result === undefined ? {} : { result }) }
}

function indeterminate(reason: string, result?: unknown): ActionOutcome {
  return { effect: 'indeterminate', reason, ...(result === undefined ? {} : { result }) }
}

function commitHookRejected(error: unknown): boolean {
  const output = landingErrorOutput(error)
  return /(?:pre-commit|prepare-commit-msg|commit-msg|hook declined|hook failed)/iu.test(
    `${output.message}\n${output.stderr}`
  )
}

function actionFingerprint(action: {
  contentIdentity: string
  kind: string
  evidenceKey: string
}): string {
  return makeAttemptFingerprint(action.contentIdentity, action.kind, action.evidenceKey)
}

function revisionTitle(binding: ObjectiveSnapshotBinding): string {
  return binding.contract.objectiveText.split(/\r?\n/u)[0]!.trim()
}

async function assertCurrentIdentity(
  action: { contentIdentity: string },
  binding: ObjectiveSnapshotBinding,
  context: ExecuteContext<ObjectiveWorld>
): Promise<boolean> {
  const identity = await computeWorkspaceContentIdentity(binding.target)
  return identity === action.contentIdentity && identity === context.snapshot.contentIdentity
}

function recordLanding(
  args: LandingExecutorArgs<CommitLocalBranchAction | PushRefAction | OpenHostedReviewAction>,
  contentIdentity: string,
  payload: RecordLandingArgs['payload']
) {
  return args.objectiveStore.recordLanding({
    watcherId: args.binding.enrollment.watcherId,
    rung: args.action.rung,
    contentIdentity,
    attemptFingerprint: actionFingerprint(args.action),
    payload,
    epoch: args.context.lease.epoch,
    createdAtMs: Date.now()
  })
}

export async function executeCommitLocalBranch(
  args: LandingExecutorArgs<CommitLocalBranchAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  if (
    (await computeObjectiveWorktreeContentDigest(args.binding.target)) !==
    args.action.worktreeContentDigest
  ) {
    return invalid('landing-evidence-stale')
  }
  const runGit = objectiveGitCommandForTarget(args.binding.target)
  const [branch, headSha] = await Promise.all([
    readObjectiveAttachedBranch(runGit),
    readObjectiveHeadSha(runGit)
  ])
  if (branch !== args.action.branch || headSha !== args.action.headSha) {
    return invalid('branch-not-attached')
  }
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--'])
  const paths = objectiveDirtyPathsByTerritory(status.stdout, args.binding)
  if (paths.inside.length === 0) {
    const parallelRun = (args.context.snapshot.world.parallel?.dispatches.length ?? 0) > 0
    if (!parallelRun || paths.outside.length > 0) {
      return invalid('nothing-to-commit', { outsideTerritoryPaths: paths.outside.slice(0, 256) })
    }
    const treeOid = (await runGit(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    await args.context.lease.assertHeld()
    recordLanding(args, args.action.contentIdentity, {
      revisionId: args.action.revisionId,
      fromContentIdentity: args.action.fromContentIdentity,
      commitSha: headSha,
      treeOid,
      branch
    })
    return {
      effect: 'landed',
      result: {
        kind: 'commit-recorded',
        naturalKey: objectiveActionNaturalKey(args.action),
        commitSha: headSha,
        contentIdentity: args.action.contentIdentity,
        outsideTerritoryPaths: []
      }
    }
  }
  await args.context.lease.assertHeld()
  for (let index = 0; index < paths.inside.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    await runGit([
      'add',
      '--',
      ...paths.inside
        .slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
        .map((path) => `:(literal)${path}`)
    ])
  }
  await args.context.lease.assertHeld()
  const message = `${revisionTitle(args.binding)}\n\n${ATTEMPT_TRAILER}: ${args.action.attemptTrailer}`
  let commitError: unknown
  try {
    await runGit([
      'commit',
      '-m',
      message,
      '--',
      ...paths.inside.map((path) => `:(literal)${path}`)
    ])
  } catch (error) {
    commitError = error
  }
  await args.context.lease.assertHeld()
  let observation: CommittedLocalBranchObservation
  try {
    observation = await observeCommittedLocalBranch(args.action, args.binding)
  } catch (error) {
    return indeterminate('commit-probe-failed', {
      commit: commitError ? landingErrorOutput(commitError) : 'completed',
      probe: landingErrorOutput(error)
    })
  }
  await args.context.lease.assertHeld()
  const outsideTerritoryPaths = observation.outsideTerritoryPaths.slice(0, 256)
  if (observation.effect === 'not-landed') {
    if (!commitError) {
      return indeterminate('commit-state-indeterminate', { outsideTerritoryPaths })
    }
    return invalid(commitHookRejected(commitError) ? 'commit-hook-failed' : 'commit-not-landed', {
      ...landingErrorOutput(commitError),
      outsideTerritoryPaths
    })
  }
  if (observation.effect === 'indeterminate') {
    return indeterminate('commit-state-indeterminate', {
      ...(commitError ? landingErrorOutput(commitError) : {}),
      outsideTerritoryPaths
    })
  }
  if (observation.worktreeContentDigest !== args.action.worktreeContentDigest) {
    return {
      effect: 'landed',
      result: {
        kind: 'commit-attribution-skipped',
        reason: 'worktree-content-changed',
        commitSha: observation.commitSha,
        observedContentIdentity: observation.contentIdentity,
        outsideTerritoryPaths
      }
    }
  }
  recordLanding(args, observation.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.fromContentIdentity,
    commitSha: observation.commitSha,
    treeOid: observation.treeOid,
    branch: observation.branch
  })
  return {
    effect: 'landed',
    result: {
      kind: 'commit-recorded',
      naturalKey: objectiveActionNaturalKey(args.action),
      commitSha: observation.commitSha,
      contentIdentity: observation.contentIdentity,
      outsideTerritoryPaths
    }
  }
}

export async function executePushRef(
  args: LandingExecutorArgs<PushRefAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  const runGit = objectiveGitCommandForTarget(args.binding.target)
  const localBranch = await readObjectiveAttachedBranch(runGit)
  if (!localBranch) {
    return invalid('branch-not-attached')
  }
  const headSha = await readObjectiveHeadSha(runGit)
  if (headSha !== args.action.commitSha) {
    return invalid('landing-evidence-stale')
  }

  const pushed = await executeLandingPushCore({
    runGit,
    localBranch,
    remote: args.action.remote,
    branch: args.action.branch,
    headSha: args.action.commitSha,
    expectedBefore: args.action.expectedState.before,
    assertLeaseHeld: () => args.context.lease.assertHeld()
  })
  if (pushed.effect === 'not-landed') {
    return invalid(pushed.reason, pushed.result)
  }
  if (pushed.effect === 'indeterminate') {
    return indeterminate(pushed.reason, pushed.result)
  }
  recordLanding(args, args.action.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.contentIdentity,
    remote: args.action.remote,
    branch: args.action.branch,
    commitSha: args.action.commitSha,
    remoteSha: pushed.remoteSha
  })
  return {
    effect: 'landed',
    expectedBefore: pushed.expectedBefore,
    expectedAfter: pushed.expectedAfter,
    result: {
      kind: 'push-recorded',
      naturalKey: objectiveActionNaturalKey(args.action),
      remoteSha: pushed.remoteSha
    }
  }
}

async function recordMatchingReview(
  args: LandingExecutorArgs<OpenHostedReviewAction>,
  review: { number: number; url: string }
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  recordLanding(args, args.action.contentIdentity, {
    revisionId: args.action.revisionId,
    fromContentIdentity: args.action.contentIdentity,
    provider: args.action.provider,
    reviewNumber: review.number,
    reviewUrl: review.url,
    branch: args.action.branch,
    headSha: args.action.headSha,
    base: args.action.base
  })
  return {
    effect: 'landed',
    expectedBefore: args.action.expectedState.before,
    expectedAfter: review.url,
    result: {
      kind: 'review-recorded',
      naturalKey: objectiveActionNaturalKey(args.action),
      reviewNumber: review.number,
      reviewUrl: review.url
    }
  }
}

export async function executeOpenHostedReview(
  args: LandingExecutorArgs<OpenHostedReviewAction>
): Promise<ActionOutcome> {
  await args.context.lease.assertHeld()
  if (!(await assertCurrentIdentity(args.action, args.binding, args.context))) {
    return invalid('landing-evidence-stale')
  }
  if (
    !reachedRungs(args.context.snapshot.world.plan.landing, args.action.contentIdentity).has(
      'pushed-ref'
    )
  ) {
    return invalid('landing-evidence-stale')
  }
  const context = objectiveForgeContext(args.binding.target)
  let provider: ForgeProvider | null
  try {
    provider = await args.forge.getProvider(context)
  } catch (error) {
    return indeterminate('forge-probe-failed', landingErrorOutput(error))
  }
  if (!provider || provider.id !== args.action.provider) {
    return invalid('forge-changed')
  }
  const outcome = await executeLandingReviewCore({
    context,
    provider,
    forge: args.forge,
    branch: args.action.branch,
    headSha: args.action.headSha,
    resolveCreation: async () => {
      const plan = args.objectiveStore.getPlan(args.action.revisionId)
      if (!plan) {
        return null
      }
      return {
        base: args.action.base,
        title: revisionTitle(args.binding),
        body: renderReviewBody(args.binding.contract, plan),
        draft: false
      }
    },
    assertLeaseHeld: () => args.context.lease.assertHeld()
  })
  if (outcome.effect === 'not-landed') {
    return invalid(outcome.reason, outcome.result)
  }
  if (outcome.effect === 'indeterminate') {
    return indeterminate(outcome.reason, outcome.result)
  }
  return recordMatchingReview(args, outcome.review)
}
