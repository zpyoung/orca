import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'
import { resolveGitLabMrStartPoint } from './mr-start-point'

const ORIGIN_URL = 'git@gitlab.com:acme/orca.git'
const durableMrLocalRef = (mrIid: number): string =>
  `refs/orca/merge-requests/${reviewHeadRemoteRefComponent('origin', ORIGIN_URL)}/${mrIid}`

const resolveRemote = async (): Promise<string> => 'origin'
const noOpFetchRemoteTrackingRef = async (): Promise<void> => {}

describe('resolveGitLabMrStartPoint', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pins the MR head and returns provider-generic start-point fields', async () => {
    const fetchRemoteTrackingRef = vi.fn(noOpFetchRemoteTrackingRef)
    const fetchMergeRequestHeadRef = vi.fn(async () => durableMrLocalRef(42))
    const gitExec = vi.fn(async (args: string[]) => {
      if (args.at(-1) === `${durableMrLocalRef(42)}^{commit}`) {
        return { stdout: 'mr-head-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitLabMrStartPoint({
      mrIid: 42,
      headRefName: 'feature/fix',
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef,
      fetchMergeRequestHeadRef,
      resolveRemote
    })

    expect(fetchMergeRequestHeadRef).toHaveBeenCalledWith('origin', 42)
    expect(fetchRemoteTrackingRef).toHaveBeenCalledWith('origin', 'main')
    expect(gitExec).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      `${durableMrLocalRef(42)}^{commit}`
    ])
    expect(result).toEqual({
      baseBranch: 'mr-head-sha',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'mr-head-sha',
      branchNameOverride: 'feature/fix',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
  })

  it('omits a push target for a cross-repository MR', async () => {
    const result = await resolveGitLabMrStartPoint({
      mrIid: 7,
      headRefName: 'contributor/fix',
      isCrossRepository: true,
      gitExec: async () => ({ stdout: 'fork-head-sha\n', stderr: '' }),
      fetchRemoteTrackingRef: noOpFetchRemoteTrackingRef,
      fetchMergeRequestHeadRef: async () => durableMrLocalRef(7),
      resolveRemote
    })

    expect(result).toEqual({
      baseBranch: 'fork-head-sha',
      headSha: 'fork-head-sha',
      branchNameOverride: 'contributor/fix'
    })
  })

  it('uses the durable ref returned by the fetch instead of FETCH_HEAD', async () => {
    const writerRef = 'refs/orca/merge-request/writer-authoritative/9'
    const gitExec = vi.fn(async (args: string[]) => {
      if (args.at(-1) === `${writerRef}^{commit}`) {
        return { stdout: 'pinned-head-sha\n', stderr: '' }
      }
      if (args.at(-1) === 'FETCH_HEAD') {
        return { stdout: 'unrelated-fetch-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitLabMrStartPoint({
      mrIid: 9,
      gitExec,
      fetchRemoteTrackingRef: noOpFetchRemoteTrackingRef,
      fetchMergeRequestHeadRef: async () => writerRef,
      resolveRemote
    })

    expect(result).toEqual({ baseBranch: 'pinned-head-sha', headSha: 'pinned-head-sha' })
    expect(gitExec).not.toHaveBeenCalledWith(['rev-parse', '--verify', 'FETCH_HEAD'])
    expect(gitExec).not.toHaveBeenCalledWith(['remote', 'get-url', 'origin'])
  })

  it('keeps a durable head and local compare base after transient fetch failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gitExec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: `${ORIGIN_URL}\n`, stderr: '' }
      }
      if (args.at(-1) === `${durableMrLocalRef(12)}^{commit}`) {
        return { stdout: 'cached-head-sha\n', stderr: '' }
      }
      if (args.at(-1) === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'cached-base-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const result = await resolveGitLabMrStartPoint({
      mrIid: 12,
      baseRefName: 'main',
      gitExec,
      fetchRemoteTrackingRef: async () => {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.com')
      },
      fetchMergeRequestHeadRef: async () => {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.com')
      },
      resolveRemote
    })

    expect(result).toEqual({
      baseBranch: 'cached-head-sha',
      compareBaseRef: 'refs/remotes/origin/main',
      headSha: 'cached-head-sha'
    })
    expect(console.warn).toHaveBeenCalledWith(
      '[gitlab:resolveMrStartPoint] MR head fetch failed; using durable local ref',
      expect.objectContaining({ remote: 'origin', mrIid: 12 })
    )
  })

  it('drops an unavailable optional compare base', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gitExec = vi.fn(async (args: string[]) => {
      if (args.at(-1) === `${durableMrLocalRef(15)}^{commit}`) {
        return { stdout: 'mr-head-sha\n', stderr: '' }
      }
      throw new Error('fatal: Needed a single revision')
    })

    const result = await resolveGitLabMrStartPoint({
      mrIid: 15,
      baseRefName: 'deleted-target',
      gitExec,
      fetchRemoteTrackingRef: async () => {
        throw new Error("fatal: couldn't find remote ref refs/heads/deleted-target")
      },
      fetchMergeRequestHeadRef: async () => durableMrLocalRef(15),
      resolveRemote
    })

    expect(result).toEqual({ baseBranch: 'mr-head-sha', headSha: 'mr-head-sha' })
    expect(console.warn).toHaveBeenCalledWith(
      '[gitlab:resolveMrStartPoint] optional compare-base fetch failed',
      expect.objectContaining({ baseRefName: 'deleted-target', localBaseResolved: false })
    )
  })

  it.each([
    ["fatal: couldn't find remote ref refs/merge-requests/18/head", 'missing MR'],
    ['Authentication failed. Check your remote credentials.', 'authentication'],
    [
      'This SSH host is running an older Orca relay that cannot fetch merge request heads.',
      'stale relay'
    ]
  ])('fails hard on a non-transient head fetch error: %s (%s)', async (message) => {
    const gitExec = vi.fn(async () => ({ stdout: 'cached-head-sha\n', stderr: '' }))

    const result = await resolveGitLabMrStartPoint({
      mrIid: 18,
      gitExec,
      fetchRemoteTrackingRef: noOpFetchRemoteTrackingRef,
      fetchMergeRequestHeadRef: async () => {
        throw new Error(message)
      },
      resolveRemote
    })

    expect(result).toEqual({
      error: `Failed to fetch refs/merge-requests/18/head: ${message}`
    })
    expect(gitExec).not.toHaveBeenCalled()
  })

  it('reports an empty durable head after a successful fetch', async () => {
    const result = await resolveGitLabMrStartPoint({
      mrIid: 21,
      gitExec: async () => ({ stdout: '\n', stderr: '' }),
      fetchRemoteTrackingRef: noOpFetchRemoteTrackingRef,
      fetchMergeRequestHeadRef: async () => durableMrLocalRef(21),
      resolveRemote
    })

    expect(result).toEqual({ error: 'Could not resolve MR !21 head after fetch.' })
  })
})
