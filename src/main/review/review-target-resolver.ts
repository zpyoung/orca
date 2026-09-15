export type ReviewResolvedTargetKind = 'git-range' | 'worktree' | 'path' | 'commit' | 'hosted'

export type ReviewGitTargetKind = Extract<
  ReviewResolvedTargetKind,
  'git-range' | 'commit' | 'hosted'
>

export type ReviewTargetInput =
  | { kind: 'custom'; target: string }
  | { kind: 'worktree' }
  | { kind: 'path'; target: string }
  | { kind: ReviewGitTargetKind; target: string }

export type ReviewGitTargetResolution = {
  targetRef: string
  baselineOid?: string | null
  headOid?: string
  providerRef?: string | null
}

export type ReviewResolvedTarget =
  | { targetKind: 'worktree'; targetRef: 'WORKTREE' }
  | { targetKind: 'path'; targetRef: string }
  | (ReviewGitTargetResolution & { targetKind: ReviewGitTargetKind })

export type ReviewTargetResolverDependencies = {
  pathExists: (path: string) => boolean | Promise<boolean>
  resolveGitTarget: (
    input: Readonly<{ kind: ReviewGitTargetKind; target: string }>
  ) => ReviewGitTargetResolution | Promise<ReviewGitTargetResolution>
}

const WINDOWS_DRIVE_PATH = /^[a-z]:/i
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)/

/** Does not depend on the OS running Orca; the execution host may be Windows. */
export function isWindowsReviewPath(target: string): boolean {
  return WINDOWS_DRIVE_PATH.test(target) || WINDOWS_UNC_PATH.test(target)
}

export async function classifyCustomReviewTarget(
  target: string,
  pathExists: ReviewTargetResolverDependencies['pathExists']
): Promise<'worktree' | 'path' | 'git-range'> {
  if (target === 'WORKTREE') {
    return 'worktree'
  }
  if (isWindowsReviewPath(target) || (await pathExists(target))) {
    return 'path'
  }
  return 'git-range'
}

async function resolveGitTarget(
  kind: ReviewGitTargetKind,
  target: string,
  dependency: ReviewTargetResolverDependencies['resolveGitTarget']
): Promise<ReviewResolvedTarget> {
  const resolution = await dependency({ kind, target })
  return { ...resolution, targetKind: kind }
}

export async function resolveReviewTarget(
  input: ReviewTargetInput,
  dependencies: ReviewTargetResolverDependencies
): Promise<ReviewResolvedTarget> {
  if (input.kind === 'worktree') {
    return { targetKind: 'worktree', targetRef: 'WORKTREE' }
  }
  if (input.kind === 'path') {
    return { targetKind: 'path', targetRef: input.target }
  }
  if (input.kind !== 'custom') {
    return resolveGitTarget(input.kind, input.target, dependencies.resolveGitTarget)
  }

  const kind = await classifyCustomReviewTarget(input.target, dependencies.pathExists)
  if (kind === 'worktree') {
    return { targetKind: kind, targetRef: 'WORKTREE' }
  }
  if (kind === 'path') {
    return { targetKind: kind, targetRef: input.target }
  }
  return resolveGitTarget(kind, input.target, dependencies.resolveGitTarget)
}
