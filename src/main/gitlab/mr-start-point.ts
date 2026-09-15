import type { GitPushTarget } from '../../shared/types'
import { fetchCompareBaseRefWithLocalFallback } from '../git/compare-base-ref-fetch'
import { isTransientReviewHeadFetchError } from '../git/fetch-error-classification'
import {
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from '../../shared/review-head-tracking-ref'

type GitExec = (args: string[]) => Promise<{ stdout: string; stderr: string }>

type ResolveGitLabMrStartPointArgs = {
  mrIid: number
  headRefName?: string
  baseRefName?: string
  isCrossRepository?: boolean
  gitExec: GitExec
  fetchRemoteTrackingRef: (remote: string, branch: string) => Promise<void>
  fetchMergeRequestHeadRef: (remote: string, mrIid: number) => Promise<string>
  resolveRemote: () => Promise<string>
}

export type GitLabMrStartPoint = {
  baseBranch: string
  compareBaseRef?: string
  pushTarget?: GitPushTarget
  headSha: string
  branchNameOverride?: string
}

type ResolveGitLabMrStartPointResult = GitLabMrStartPoint | { error: string }

export async function resolveGitLabMrStartPoint(
  args: ResolveGitLabMrStartPointArgs
): Promise<ResolveGitLabMrStartPointResult> {
  const headRefName = args.headRefName?.trim() ?? ''
  const baseRefName = args.baseRefName?.trim() ?? ''

  let remote: string
  try {
    remote = await args.resolveRemote()
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not resolve git remote.' }
  }

  const compareBaseRef = baseRefName ? `refs/remotes/${remote}/${baseRefName}` : undefined
  const fetchCompareBaseRef = (): Promise<boolean> =>
    fetchCompareBaseRefWithLocalFallback({
      compareBaseRef,
      fetchCompareBaseRef: () => args.fetchRemoteTrackingRef(remote, baseRefName),
      gitExec: args.gitExec,
      logLabel: '[gitlab:resolveMrStartPoint]',
      logContext: { remote, baseRefName, mrIid: args.mrIid }
    })

  const mrRef = `refs/merge-requests/${args.mrIid}/head`
  let softKeepLocalRefPromise: Promise<string | null> | undefined
  const resolveSoftKeepLocalRef = (): Promise<string | null> => {
    softKeepLocalRefPromise ??= (async () => {
      try {
        const { stdout } = await args.gitExec(['remote', 'get-url', remote])
        const remoteUrl = stdout.trim()
        if (!remoteUrl) {
          return null
        }
        return gitlabMergeRequestHeadLocalRef(
          reviewHeadRemoteRefComponent(remote, remoteUrl),
          args.mrIid
        )
      } catch {
        return null
      }
    })()
    return softKeepLocalRefPromise
  }
  const resolveDurableHeadSha = async (localRef: string | null): Promise<string | null> => {
    if (!localRef) {
      return null
    }
    try {
      const { stdout } = await args.gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  let headSha: string
  try {
    const localRef = await args.fetchMergeRequestHeadRef(remote, args.mrIid)
    const resolved = await resolveDurableHeadSha(localRef)
    if (!resolved) {
      return { error: `Could not resolve MR !${args.mrIid} head after fetch.` }
    }
    headSha = resolved
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isTransientReviewHeadFetchError(error)) {
      const localSha = await resolveDurableHeadSha(await resolveSoftKeepLocalRef())
      if (localSha) {
        console.warn('[gitlab:resolveMrStartPoint] MR head fetch failed; using durable local ref', {
          remote,
          mrIid: args.mrIid,
          error: message.split('\n')[0]
        })
        headSha = localSha
      } else {
        return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
      }
    } else {
      return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
    }
  }

  const compareBaseFetched = await fetchCompareBaseRef()
  return {
    baseBranch: headSha,
    ...(compareBaseFetched && compareBaseRef ? { compareBaseRef } : {}),
    headSha,
    ...(headRefName ? { branchNameOverride: headRefName } : {}),
    ...(headRefName && !args.isCrossRepository
      ? { pushTarget: { remoteName: remote, branchName: headRefName } }
      : {})
  }
}
