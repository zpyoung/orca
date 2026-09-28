import type {
  ObjectiveLandingContext,
  ObjectiveProjection
} from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveLandingBar } from '../../shared/fork-heimdall-objective/contract-types'
import {
  highestReachedRung,
  stopRungForBar
} from '../../shared/fork-heimdall-objective/landing-ladder'
import { objectiveGitCommandForTarget, type ObjectiveWorkspaceTarget } from './content-identity'
import { objectiveForgeContext, type ObjectiveForgeAccess } from './objective-forge-access'
import {
  readObjectiveAttachedBranch,
  readObjectiveHeadSha,
  resolveObjectivePushTarget
} from './landing-git-state'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

export async function readObjectiveLandingContext(args: {
  target: ObjectiveWorkspaceTarget
  projection: ObjectiveProjection
  contentIdentity: string
  repoKey: string
  landingBar: ObjectiveLandingBar
  forge: ObjectiveForgeAccess
}): Promise<ObjectiveLandingContext> {
  const empty: ObjectiveLandingContext = {
    branch: null,
    headSha: null,
    pushTarget: null,
    hostedReview: null,
    worktreeContentDigest: null
  }
  if (args.target.kind !== 'git') {
    return empty
  }
  const highest = highestReachedRung(args.projection.landing, args.contentIdentity)
  if (highest === null || highest === stopRungForBar(args.landingBar)) {
    return empty
  }
  const runGit = objectiveGitCommandForTarget(args.target)
  const [branch, headSha, worktreeContentDigest] = await Promise.all([
    readObjectiveAttachedBranch(runGit),
    readObjectiveHeadSha(runGit),
    highest === 'files-on-disk'
      ? computeObjectiveWorktreeContentDigest(args.target)
      : Promise.resolve(null)
  ])
  const context: ObjectiveLandingContext = {
    ...empty,
    branch,
    headSha,
    worktreeContentDigest
  }
  if (!branch || !headSha || highest === 'files-on-disk') {
    return context
  }
  const pushTarget = await resolveObjectivePushTarget(runGit, branch)
  context.pushTarget = pushTarget
  if (!pushTarget || highest === 'committed-local-branch') {
    return context
  }
  const forgeContext = objectiveForgeContext(args.target)
  const [provider, base] = await Promise.all([
    args.forge.detectProvider(forgeContext),
    args.forge.getDefaultBranch(forgeContext)
  ])
  if (provider === 'github' || provider === 'gitlab') {
    context.hostedReview = { provider, repoKey: args.repoKey, base }
  }
  return context
}
