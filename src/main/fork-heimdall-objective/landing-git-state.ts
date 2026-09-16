import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import type { ObjectiveGitCommand } from './content-identity'

const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/iu

export type ObjectivePushTarget = {
  remote: string
  branch: string
  remoteSha: string
}

function parsePushBranch(refspec: string): string | null {
  const separator = refspec.indexOf(':')
  if (separator === -1) {
    return null
  }
  const destination = refspec.slice(separator + 1)
  const branch = destination.replace(/^refs\/heads\//u, '')
  return branch && !branch.startsWith('refs/') ? branch : null
}

export async function readObjectiveAttachedBranch(
  runGit: ObjectiveGitCommand
): Promise<string | null> {
  try {
    return (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null
  } catch {
    return null
  }
}

export async function readObjectiveHeadSha(runGit: ObjectiveGitCommand): Promise<string | null> {
  try {
    const sha = (await runGit(['rev-parse', '--verify', 'HEAD'])).stdout.trim()
    return OBJECT_ID_PATTERN.test(sha) ? sha : null
  } catch {
    return null
  }
}

async function originExists(runGit: ObjectiveGitCommand): Promise<boolean> {
  try {
    return Boolean((await runGit(['remote', 'get-url', '--push', 'origin'])).stdout.trim())
  } catch {
    return false
  }
}

export async function readObjectiveRemoteBranchHead(
  runGit: ObjectiveGitCommand,
  remote: string,
  branch: string
): Promise<string> {
  const ref = `refs/heads/${branch}`
  const lines = (await runGit(['ls-remote', '--heads', remote, ref])).stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const match = lines.find((line) => line.split(/\s+/u)[1] === ref)
  const sha = match?.split(/\s+/u)[0]
  if (!sha) {
    return ''
  }
  if (!OBJECT_ID_PATTERN.test(sha)) {
    throw new Error('Git returned an invalid remote branch object id')
  }
  return sha
}

export async function resolveObjectivePushTarget(
  runGit: ObjectiveGitCommand,
  localBranch: string
): Promise<ObjectivePushTarget | null> {
  const configured = await resolveConfiguredGitPushTarget(runGit)
  const remote = configured?.remote ?? 'origin'
  const branch = configured ? parsePushBranch(configured.refspec) : localBranch
  if (!branch || (!configured && !(await originExists(runGit)))) {
    return null
  }
  return {
    remote,
    branch,
    remoteSha: await readObjectiveRemoteBranchHead(runGit, remote, branch)
  }
}
