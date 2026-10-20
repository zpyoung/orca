import type { CreateHostedReviewResult, HostedReviewInfo } from '../../shared/hosted-review'
import type {
  ForgeProvider,
  ForgeProviderRepositoryContext
} from '../source-control/forge-provider'
import type { ObjectiveGitCommand } from './content-identity'
import type { ObjectivePushTarget } from './landing-git-state'
import {
  objectiveRemoteRefSha,
  objectiveRemoteRefState,
  readObjectiveRemoteBranchHead,
  resolveObjectivePushTarget
} from './landing-git-state'
import type { ObjectiveForgeAccess } from './objective-forge-access'
export type LandingPushCoreResult =
  | {
      effect: 'landed'
      expectedBefore: string
      expectedAfter: string
      remoteSha: string
    }
  | { effect: 'not-landed'; reason: string; result?: unknown }
  | { effect: 'indeterminate'; reason: string; result?: unknown }

export type LandingReviewCoreResult =
  | { effect: 'landed'; review: HostedReviewInfo }
  | { effect: 'not-landed'; reason: string; result?: unknown }
  | { effect: 'indeterminate'; reason: string; result?: unknown }

export type LandingErrorOutput = { message: string; stdout: string; stderr: string }

/** Converts Git and forge failures to the structured diagnostic used by landing outcomes. */
export function landingErrorOutput(error: unknown): LandingErrorOutput {
  if (!error || typeof error !== 'object') {
    return { message: String(error), stdout: '', stderr: '' }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  }
}

function porcelainPushWasRejected(error: unknown, remoteRef: string): boolean {
  const output = landingErrorOutput(error)
  return [output.message, output.stdout, output.stderr].some((text) =>
    text.split(/\r?\n/u).some((line) => {
      const [flag, refspec, summary] = line.split('\t')
      return (
        flag?.trim() === '!' &&
        refspec?.endsWith(`:${remoteRef}`) === true &&
        /^\[(?:remote )?rejected\](?: \(.+\))?$/u.test(summary ?? '')
      )
    })
  )
}

/** Pushes only from the captured remote state, then verifies the authoritative ref. */
export async function executeLandingPushCore(args: {
  runGit: ObjectiveGitCommand
  localBranch: string
  remote: string
  branch: string
  headSha: string
  expectedBefore: string
  alreadyAtTargetIsLanded?: boolean
  assertLeaseHeld?: () => Promise<void>
}): Promise<LandingPushCoreResult> {
  let target: ObjectivePushTarget | null
  try {
    target = await resolveObjectivePushTarget(args.runGit, args.localBranch)
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: 'push-probe-failed',
      result: landingErrorOutput(error)
    }
  }
  if (!target || target.remote !== args.remote || target.branch !== args.branch) {
    return { effect: 'not-landed', reason: 'push-target-changed' }
  }
  if (target.remoteSha === args.headSha) {
    return args.alreadyAtTargetIsLanded
      ? {
          effect: 'landed',
          expectedBefore: args.expectedBefore,
          expectedAfter: args.headSha,
          remoteSha: target.remoteSha
        }
      : { effect: 'not-landed', reason: 'expected-state-moved' }
  }
  if (target.remoteSha !== args.expectedBefore) {
    return { effect: 'not-landed', reason: 'expected-state-moved' }
  }

  await args.runGit(['check-ref-format', '--branch', args.branch])
  await args.runGit(['cat-file', '-e', `${args.headSha}^{commit}`])
  await args.assertLeaseHeld?.()

  const remoteRef = `refs/heads/${args.branch}`
  const expectedBeforeSha = objectiveRemoteRefSha(args.expectedBefore)
  let pushError: unknown
  try {
    await args.runGit([
      'push',
      '--porcelain',
      `--force-with-lease=${remoteRef}:${expectedBeforeSha}`,
      args.remote,
      `${args.headSha}:${remoteRef}`
    ])
  } catch (error) {
    pushError = error
  }
  await args.assertLeaseHeld?.()

  let observed: string
  try {
    observed = await readObjectiveRemoteBranchHead(args.runGit, args.remote, args.branch)
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: 'push-probe-failed',
      result: {
        push: pushError ? landingErrorOutput(pushError) : 'completed',
        probe: landingErrorOutput(error)
      }
    }
  }
  await args.assertLeaseHeld?.()
  const observedState = objectiveRemoteRefState(observed)
  if (observed === args.headSha) {
    return {
      effect: 'landed',
      expectedBefore: args.expectedBefore,
      expectedAfter: args.headSha,
      remoteSha: observed
    }
  }
  if (pushError && porcelainPushWasRejected(pushError, remoteRef)) {
    return {
      effect: 'not-landed',
      reason: observedState === args.expectedBefore ? 'push-not-landed' : 'remote-moved',
      result: landingErrorOutput(pushError)
    }
  }
  if (observedState === args.expectedBefore) {
    return {
      effect: 'not-landed',
      reason: 'push-not-landed',
      ...(pushError ? { result: landingErrorOutput(pushError) } : {})
    }
  }
  return {
    effect: 'indeterminate',
    reason: 'push-state-indeterminate',
    result: { observed: observedState, ...(pushError ? landingErrorOutput(pushError) : {}) }
  }
}

function reviewIsLive(review: HostedReviewInfo | null): review is HostedReviewInfo {
  return review !== null && (review.state === 'open' || review.state === 'draft')
}

function reviewMatchesHead(
  review: HostedReviewInfo | null,
  headSha: string
): review is HostedReviewInfo {
  return reviewIsLive(review) && review.headSha === headSha
}

/** Reuses a matching live review or probes before and after creation. */
export async function executeLandingReviewCore(args: {
  context: ForgeProviderRepositoryContext
  provider: ForgeProvider
  forge: ObjectiveForgeAccess
  branch: string
  headSha: string
  resolveCreation: () => Promise<{
    base: string
    title: string
    body: string
    draft: boolean
  } | null>
  assertLeaseHeld?: () => Promise<void>
}): Promise<LandingReviewCoreResult> {
  const createReview = args.provider.createReview?.bind(args.provider)
  if (!args.provider.supportsReviewCreation || !createReview) {
    return { effect: 'not-landed', reason: 'forge-cannot-create' }
  }
  const reviewInput = {
    ...args.context,
    branch: args.branch,
    githubCurrentHeadOid: args.headSha
  }
  let existing: HostedReviewInfo | null
  try {
    existing = await args.provider.getReviewForBranch(reviewInput)
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: 'hosted-review-probe-failed',
      result: landingErrorOutput(error)
    }
  }
  if (reviewMatchesHead(existing, args.headSha)) {
    return { effect: 'landed', review: existing }
  }
  if (existing && reviewIsLive(existing)) {
    return { effect: 'indeterminate', reason: 'hosted-review-state-moved' }
  }
  try {
    if (!(await args.forge.isAuthenticated(args.provider.id, args.context))) {
      return { effect: 'not-landed', reason: 'auth_required' }
    }
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: 'forge-auth-probe-failed',
      result: landingErrorOutput(error)
    }
  }
  const creation = await args.resolveCreation()
  if (!creation) {
    return { effect: 'not-landed', reason: 'landing-plan-missing' }
  }

  await args.assertLeaseHeld?.()
  let result: CreateHostedReviewResult | undefined
  let creationError: unknown
  try {
    result = await createReview(
      args.context.repoPath,
      {
        provider: args.provider.id,
        base: creation.base,
        head: args.branch,
        title: creation.title,
        body: creation.body,
        draft: creation.draft,
        worktreePath: args.context.repoPath,
        useTemplate: true
      },
      args.context.executionHostId,
      args.context
    )
  } catch (error) {
    creationError = error
  }
  await args.assertLeaseHeld?.()
  args.forge.invalidate(args.context)

  let authoritative: HostedReviewInfo | null
  try {
    authoritative = await args.provider.getReviewForBranch(reviewInput)
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: 'hosted-review-probe-failed',
      result: {
        create: creationError ? landingErrorOutput(creationError) : result,
        probe: landingErrorOutput(error)
      }
    }
  }
  if (reviewMatchesHead(authoritative, args.headSha)) {
    return { effect: 'landed', review: authoritative }
  }
  if (authoritative && reviewIsLive(authoritative)) {
    return { effect: 'indeterminate', reason: 'hosted-review-state-moved' }
  }
  if (creationError) {
    return {
      effect: 'indeterminate',
      reason: 'hosted-review-create-failed',
      result: landingErrorOutput(creationError)
    }
  }
  if (!result) {
    return { effect: 'indeterminate', reason: 'hosted-review-create-unverifiable' }
  }
  if (
    !result.ok &&
    result.code !== 'already_exists' &&
    (result.code === 'validation' ||
      result.code === 'push_failed' ||
      result.code === 'unsupported_provider' ||
      result.code === 'auth_required')
  ) {
    return { effect: 'not-landed', reason: result.code, result }
  }
  if (!result.ok && result.code !== 'already_exists') {
    return { effect: 'indeterminate', reason: result.code, result }
  }
  return { effect: 'indeterminate', reason: 'hosted-review-create-unverifiable', result }
}
