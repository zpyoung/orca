import { win32 } from 'node:path'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type { ActionOutcome, EffectCertainty } from '../../shared/fork-heimdall/effect-certainty'
import { resolveByExpectedState } from '../../shared/fork-heimdall/effect-certainty'
import { OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE } from '../../shared/fork-heimdall/objective-git-exec-shapes'
import type { PipelineLandingFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import {
  landActionExpectedState,
  type PipelineLandActionFacts
} from '../../shared/fork-heimdall-pipeline/interpreter/action-envelope'
import {
  isObjectiveMetadataPath,
  objectiveGitCommandForTarget,
  parseObjectiveDirtyPaths
} from '../fork-heimdall-objective/content-identity'
import type {
  ObjectiveGitCommand,
  ObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import {
  defaultObjectiveForgeAccess,
  objectiveForgeContext
} from '../fork-heimdall-objective/objective-forge-access'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'
import type { ForgeProvider } from '../source-control/forge-provider'
import {
  objectiveRemoteRefState,
  readObjectiveRemoteBranchHead,
  resolveObjectivePushTarget
} from '../fork-heimdall-objective/landing-git-state'
import type { ObjectivePushTarget } from '../fork-heimdall-objective/landing-git-state'
import {
  executeLandingPushCore,
  executeLandingReviewCore,
  landingErrorOutput
} from '../fork-heimdall-objective/landing-push-review-core'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'

const ATTEMPT_TRAILER = 'Orca-Heimdall-Attempt'

export type LandCommitRecovery = { landed: true; headSha: string } | { landed: false }

export type LandNodeExecutorDependencies = {
  target: ObjectiveWorkspaceTarget
  forge?: ObjectiveForgeAccess
  assertLeaseHeld?: () => Promise<void>
}

export type LandReviewExecutorDependencies = LandNodeExecutorDependencies & {
  headSha: string
  pushTarget: ObjectivePushTarget
  provider: 'github' | 'gitlab'
  base: string
}

/** Carries a classified effect outcome from a Land runner to the pipeline kind. */
export class LandNodeActionError extends Error {
  constructor(readonly outcome: ActionOutcome) {
    super(outcome.reason ?? `Land action ${outcome.effect}`)
    this.name = 'LandNodeActionError'
  }
}

function requireGitTarget(
  workspacePath: string,
  target: ObjectiveWorkspaceTarget
): ObjectiveWorkspaceTarget {
  if (target.kind !== 'git') {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'git-only-node-in-folder' })
  }
  if (target.workspacePath !== workspacePath) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'workspace-target-mismatch' })
  }
  return target
}

async function readAttachedBranch(runGit: ObjectiveGitCommand): Promise<string | null> {
  try {
    return (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return null
    }
    throw error
  }
}

async function readHeadSha(runGit: ObjectiveGitCommand): Promise<string | null> {
  try {
    const headSha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    if (!isObjectiveGitObjectId(headSha)) {
      throw new Error('Git returned an invalid HEAD object id')
    }
    return headSha
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 128 &&
      'stderr' in error &&
      typeof error.stderr === 'string' &&
      /(?:Needed a single revision|unknown revision)/u.test(error.stderr)
    ) {
      return null
    }
    throw error
  }
}

function landableDirtyPaths(status: string, target: ObjectiveWorkspaceTarget): string[] {
  const caseInsensitivePaths =
    resolveLeasePathFlavor(target.executionHostId, target.workspacePath) === win32
  const paths = parseObjectiveDirtyPaths(status, caseInsensitivePaths)
    .entries.map((entry) => entry.path)
    .filter((path) => {
      const candidate = caseInsensitivePaths ? path.toLowerCase() : path
      return (
        candidate !== '.git' &&
        !candidate.startsWith('.git/') &&
        !isObjectiveMetadataPath(path, caseInsensitivePaths)
      )
    })
  return [...new Set(paths)]
}

function commitMessageWithAttempt(message: string, attemptFingerprint: string): string {
  if (!attemptFingerprint || /[\r\n]/u.test(attemptFingerprint)) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'invalid-attempt-fingerprint' })
  }
  const normalizedMessage = message.replace(/\r\n?/gu, '\n').trimEnd()
  if (normalizedMessage.split('\n').some((line) => line.startsWith(`${ATTEMPT_TRAILER}: `))) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'reserved-attempt-trailer' })
  }
  return `${normalizedMessage ? `${normalizedMessage}\n\n` : ''}${ATTEMPT_TRAILER}: ${attemptFingerprint}`
}

function messageHasAttemptTrailer(message: string, attemptFingerprint: string): boolean {
  const lines = message.replace(/\r\n/gu, '\n').trimEnd().split('\n')
  return (
    lines.filter((line) => line.startsWith(`${ATTEMPT_TRAILER}: `)).length === 1 &&
    lines.at(-1) === `${ATTEMPT_TRAILER}: ${attemptFingerprint}`
  )
}

/** Stages non-metadata worktree changes and commits them once under the attempt trailer. */
export async function executeLandCommit(
  input: { workspacePath: string; attemptFingerprint: string; message: string },
  deps: LandNodeExecutorDependencies
): Promise<
  { status: 'committed'; headSha: string } | { status: 'nothing-to-commit'; headSha: string }
> {
  const target = requireGitTarget(input.workspacePath, deps.target)
  const runGit = objectiveGitCommandForTarget(target)
  await deps.assertLeaseHeld?.()
  const priorCommit = await recoverLandCommit(input, deps)
  if (priorCommit.landed) {
    return { status: 'committed', headSha: priorCommit.headSha }
  }
  const branch = await readAttachedBranch(runGit)
  if (!branch) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'branch-not-attached' })
  }
  const status = await runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--'])
  const paths = landableDirtyPaths(status.stdout, target)
  if (paths.length === 0) {
    const headSha = await readHeadSha(runGit)
    if (!headSha) {
      throw new LandNodeActionError({ effect: 'not-landed', reason: 'head-not-found' })
    }
    return { status: 'nothing-to-commit', headSha }
  }

  const message = commitMessageWithAttempt(input.message, input.attemptFingerprint)
  const pathspecs = paths.map((path) => `:(literal)${path}`)
  for (let index = 0; index < pathspecs.length; index += OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE) {
    await deps.assertLeaseHeld?.()
    await runGit([
      'add',
      '--',
      ...pathspecs.slice(index, index + OBJECTIVE_GIT_EXEC_PATH_BATCH_SIZE)
    ])
  }
  await deps.assertLeaseHeld?.()
  let commitError: unknown
  try {
    await runGit(['-c', 'core.hooksPath=', 'commit', '-m', message, '--', ...pathspecs])
  } catch (error) {
    commitError = error
  }
  await deps.assertLeaseHeld?.()

  let recovery: LandCommitRecovery
  try {
    recovery = await recoverLandCommit(input, deps)
  } catch (error) {
    throw new LandNodeActionError({
      effect: 'indeterminate',
      reason: 'commit-probe-failed',
      result: {
        commit: commitError ? landingErrorOutput(commitError) : 'completed',
        probe: landingErrorOutput(error)
      }
    })
  }
  if (recovery.landed) {
    return { status: 'committed', headSha: recovery.headSha }
  }
  if (commitError) {
    throw new LandNodeActionError({
      effect: 'not-landed',
      reason: 'commit-not-landed',
      result: landingErrorOutput(commitError)
    })
  }
  throw new LandNodeActionError({ effect: 'indeterminate', reason: 'commit-state-indeterminate' })
}

/** Recovers a commit only when HEAD itself has this attempt's final commit trailer. */
export async function recoverLandCommit(
  input: { workspacePath: string; attemptFingerprint: string },
  deps: LandNodeExecutorDependencies
): Promise<LandCommitRecovery> {
  const target = requireGitTarget(input.workspacePath, deps.target)
  const runGit = objectiveGitCommandForTarget(target)
  const headSha = await readHeadSha(runGit)
  if (!headSha) {
    return { landed: false }
  }
  const message = (await runGit(['log', '-1', '--format=%B'])).stdout
  return messageHasAttemptTrailer(message, input.attemptFingerprint)
    ? { landed: true, headSha }
    : { landed: false }
}

/** Pushes the captured remote ref with an exact force-with-lease and verifies the remote head. */
export async function executeLandPush(
  input: {
    workspacePath: string
    branch: string
    headSha: string
    target: ObjectivePushTarget
  },
  deps: LandNodeExecutorDependencies
): Promise<{ status: 'pushed'; remoteHeadSha: string }> {
  const target = requireGitTarget(input.workspacePath, deps.target)
  const runGit = objectiveGitCommandForTarget(target)
  await deps.assertLeaseHeld?.()
  const [localBranch, headSha] = await Promise.all([
    readAttachedBranch(runGit),
    readHeadSha(runGit)
  ])
  if (!localBranch || input.branch !== input.target.branch || headSha !== input.headSha) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'landing-evidence-stale' })
  }
  const pushed = await executeLandingPushCore({
    runGit,
    localBranch,
    remote: input.target.remote,
    branch: input.target.branch,
    headSha: input.headSha,
    expectedBefore: input.target.remoteSha,
    alreadyAtTargetIsLanded: true,
    assertLeaseHeld: deps.assertLeaseHeld
  })
  if (pushed.effect !== 'landed') {
    throw new LandNodeActionError({
      effect: pushed.effect,
      reason: pushed.reason,
      expectedBefore: input.target.remoteSha,
      expectedAfter: input.headSha,
      ...(pushed.result === undefined ? {} : { result: pushed.result })
    })
  }
  return { status: 'pushed', remoteHeadSha: pushed.remoteSha }
}

/** Probes the captured remote ref without performing another push. */
export async function recoverLandPush(
  input: {
    workspacePath: string
    branch: string
    headSha: string
    target: ObjectivePushTarget
  },
  deps: LandNodeExecutorDependencies
): Promise<EffectCertainty> {
  try {
    const target = requireGitTarget(input.workspacePath, deps.target)
    if (input.branch !== input.target.branch) {
      return 'indeterminate'
    }
    const runGit = objectiveGitCommandForTarget(target)
    const observed = await readObjectiveRemoteBranchHead(
      runGit,
      input.target.remote,
      input.target.branch
    )
    return resolveByExpectedState(
      objectiveRemoteRefState(observed),
      input.target.remoteSha,
      input.headSha
    )
  } catch {
    return 'indeterminate'
  }
}

/** Opens or reuses a GitHub/GitLab review for the captured remote head. */
export async function executeLandOpenReview(
  input: { workspacePath: string; branch: string; title: string; body: string; draft: boolean },
  deps: LandReviewExecutorDependencies
): Promise<{
  prUrl: string
  prNumber: number
  branch: string
  headSha: string
  provider: 'github' | 'gitlab'
}> {
  const target = requireGitTarget(input.workspacePath, deps.target)
  const runGit = objectiveGitCommandForTarget(target)
  await deps.assertLeaseHeld?.()
  let observedHead: string
  try {
    observedHead = await readObjectiveRemoteBranchHead(
      runGit,
      deps.pushTarget.remote,
      deps.pushTarget.branch
    )
  } catch (error) {
    throw new LandNodeActionError({
      effect: 'indeterminate',
      reason: 'push-probe-failed',
      result: landingErrorOutput(error)
    })
  }
  if (observedHead !== deps.headSha || input.branch !== deps.pushTarget.branch) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'landing-evidence-stale' })
  }

  const forge = deps.forge ?? defaultObjectiveForgeAccess
  const context = objectiveForgeContext(target)
  let provider: ForgeProvider | null
  try {
    provider = await forge.getProvider(context)
  } catch (error) {
    throw new LandNodeActionError({
      effect: 'indeterminate',
      reason: 'forge-probe-failed',
      result: landingErrorOutput(error)
    })
  }
  if (!provider || provider.id !== deps.provider) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'forge-changed' })
  }
  const outcome = await executeLandingReviewCore({
    context,
    provider,
    forge,
    branch: input.branch,
    headSha: deps.headSha,
    resolveCreation: async () => ({
      base: deps.base,
      title: input.title,
      body: input.body,
      draft: input.draft
    }),
    assertLeaseHeld: deps.assertLeaseHeld
  })
  if (outcome.effect !== 'landed') {
    throw new LandNodeActionError({
      effect: outcome.effect,
      reason: outcome.reason,
      ...(outcome.result === undefined ? {} : { result: outcome.result })
    })
  }
  return {
    prUrl: outcome.review.url,
    prNumber: outcome.review.number,
    branch: input.branch,
    headSha: deps.headSha,
    provider: deps.provider
  }
}

/** Probes a branch review and never creates one during recovery. */
export async function recoverLandOpenReview(
  input: { workspacePath: string; branch: string },
  deps: LandReviewExecutorDependencies
): Promise<EffectCertainty> {
  try {
    const target = requireGitTarget(input.workspacePath, deps.target)
    if (input.branch !== deps.pushTarget.branch) {
      return 'indeterminate'
    }
    const forge = deps.forge ?? defaultObjectiveForgeAccess
    const context = objectiveForgeContext(target)
    const provider = await forge.getProvider(context)
    if (!provider || provider.id !== deps.provider) {
      return 'indeterminate'
    }
    const review = await provider.getReviewForBranch({
      ...context,
      branch: input.branch,
      githubCurrentHeadOid: deps.headSha
    })
    if (review && (review.state === 'open' || review.state === 'draft')) {
      return review.headSha === deps.headSha ? 'landed' : 'indeterminate'
    }
    return 'not-landed'
  } catch {
    return 'indeterminate'
  }
}

/** Derives expected-state identity exclusively from the host-owned facts used by the action. */
export function landExpectedState(
  kind: 'pipeline-land-push' | 'pipeline-land-open-review',
  facts: PipelineLandActionFacts
): { target: string; before: string } {
  const expectedState = landActionExpectedState(kind, facts)
  if (!expectedState) {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'landing-state-unavailable' })
  }
  return expectedState
}

/** Reads the host-routed Git and forge facts used to construct Land actions and approvals. */
export async function readPipelineLandingFacts(args: {
  target: ObjectiveWorkspaceTarget
  repoKey: string
  forge?: ObjectiveForgeAccess
}): Promise<PipelineLandingFacts> {
  if (args.target.kind !== 'git') {
    throw new LandNodeActionError({ effect: 'not-landed', reason: 'git-only-node-in-folder' })
  }
  const runGit = objectiveGitCommandForTarget(args.target)
  const [branch, headSha] = await Promise.all([readAttachedBranch(runGit), readHeadSha(runGit)])
  const pushTarget = branch ? await resolveObjectivePushTarget(runGit, branch) : null
  let hostedReview: PipelineLandingFacts['hostedReview'] = null
  if (pushTarget) {
    const forge = args.forge ?? defaultObjectiveForgeAccess
    const context = objectiveForgeContext(args.target)
    const provider = await forge.detectProvider(context)
    if (provider === 'github' || provider === 'gitlab') {
      hostedReview = {
        provider,
        repoKey: args.repoKey,
        base: await forge.getDefaultBranch(context)
      }
    }
  }
  return { branch, headSha, pushTarget, hostedReview }
}
