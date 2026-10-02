import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CreateHostedReviewInput, HostedReviewInfo } from '../../shared/hosted-review'
import { OBJECTIVE_ABSENT_REMOTE_REF_STATE } from '../../shared/fork-heimdall-objective/contract-types'
import type { PipelineLandingFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import type { ForgeProvider } from '../source-control/forge-provider'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import {
  git,
  gitText,
  createLandingRepositoryFixture
} from '../fork-heimdall-objective/objective-git-test-fixtures'
import type { LandingRepositoryFixture } from '../fork-heimdall-objective/objective-git-test-fixtures'
import { objectiveGitCommandForTarget } from '../fork-heimdall-objective/content-identity'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'
import { resolveObjectivePushTarget } from '../fork-heimdall-objective/landing-git-state'
import type { ObjectivePushTarget } from '../fork-heimdall-objective/landing-git-state'
import { cleanupTemporaryDirectories } from '../fork-heimdall-objective/objective-temp-workspace-test-fixtures'
import {
  executeLandCommit,
  executeLandOpenReview,
  executeLandPush,
  landExpectedState,
  readPipelineLandingFacts,
  recoverLandCommit,
  recoverLandOpenReview,
  recoverLandPush
} from './land-node-executor'

const temporaryDirectories: string[] = []
const SSH_CONNECTION_ID = 'pipeline-land-test'
const SSH_EXECUTION_HOST = 'ssh:pipeline-land-test'

afterEach(async () => {
  unregisterSshGitProvider(SSH_CONNECTION_ID)
  await cleanupTemporaryDirectories(temporaryDirectories)
})

async function landingFixture() {
  return await createLandingRepositoryFixture(temporaryDirectories, {
    tempPrefix: 'orca-pipeline-land-',
    userName: 'Pipeline Land Test',
    userEmail: 'pipeline-land@example.test'
  })
}

async function pushTargetFor(
  target: ObjectiveWorkspaceTarget,
  branch = 'main'
): Promise<ObjectivePushTarget> {
  const pushTarget = await resolveObjectivePushTarget(objectiveGitCommandForTarget(target), branch)
  if (!pushTarget) {
    throw new Error('The test repository has no configured push target')
  }
  return pushTarget
}

function reviewInfo(
  provider: 'github' | 'gitlab',
  headSha: string,
  overrides: Partial<HostedReviewInfo> = {}
): HostedReviewInfo {
  return {
    provider,
    number: 31,
    title: 'Land the pipeline change',
    state: 'open',
    url:
      provider === 'github'
        ? `https://${provider}.test/acme/repo/pull/31`
        : `https://${provider}.test/acme/repo/merge_requests/31`,
    status: 'success',
    updatedAt: '2026-09-30T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha,
    ...overrides
  }
}

type ReviewAccessState = {
  createdCount: number
  reviewReadCount: number
  createInputs: CreateHostedReviewInput[]
  failNextProbe: boolean
  loseNextCreateResponse: boolean
}

type ReviewAccessFixture = {
  forge: ObjectiveForgeAccess
  provider: ForgeProvider
  state: ReviewAccessState
}

function reviewAccess(
  providerId: 'github' | 'gitlab',
  headSha: string,
  existing: HostedReviewInfo | null = null
): ReviewAccessFixture {
  let review = existing
  const state: ReviewAccessState = {
    createdCount: 0,
    reviewReadCount: 0,
    createInputs: [],
    failNextProbe: false,
    loseNextCreateResponse: false
  }
  const provider: ForgeProvider = {
    id: providerId,
    supportsReviewCreation: true,
    resolveRepository: async () => ({ id: 'acme/repo' }),
    async getReviewForBranch() {
      state.reviewReadCount += 1
      if (state.failNextProbe) {
        state.failNextProbe = false
        throw new Error('forge unavailable')
      }
      return review
    },
    getReviewByNumber: async () => review,
    async createReview(_repoPath, input) {
      state.createdCount += 1
      state.createInputs.push(input)
      review = reviewInfo(providerId, headSha)
      if (state.loseNextCreateResponse) {
        state.loseNextCreateResponse = false
        throw new Error('creation response lost')
      }
      return { ok: true, number: review.number, url: review.url }
    }
  }
  return {
    provider,
    state,
    forge: {
      detectProvider: async () => providerId,
      getProvider: async () => provider,
      getDefaultBranch: async () => 'main',
      isAuthenticated: async () => true,
      invalidate() {}
    }
  }
}

async function commitAndPush(fixture: LandingRepositoryFixture) {
  await writeFile(join(fixture.root, 'src', 'result.txt'), 'pipeline land change\n')
  const committed = await executeLandCommit(
    {
      workspacePath: fixture.root,
      attemptFingerprint: 'land-attempt-1',
      message: 'Land pipeline change'
    },
    { target: fixture.target }
  )
  if (committed.status !== 'committed') {
    throw new Error('The test fixture did not produce a commit')
  }
  const target = await pushTargetFor(fixture.target)
  const pushed = await executeLandPush(
    { workspacePath: fixture.root, branch: 'main', headSha: committed.headSha, target },
    { target: fixture.target }
  )
  return { headSha: committed.headSha, pushTarget: target, pushed }
}

describe('pipeline Land executor commits', () => {
  it('commits dirty source paths without committing staged .orca metadata and recovers its trailer', async () => {
    const fixture = await landingFixture()
    const hook = join(fixture.root, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\nexit 23\n')
    await chmod(hook, 0o755)
    await mkdir(join(fixture.root, '.orca', 'pipelines'), { recursive: true })
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'pipeline result\n')
    await writeFile(join(fixture.root, '.orca', 'pipelines', 'x.yaml'), 'version: 1\n')
    await git(fixture.root, ['add', '--', '.orca/pipelines/x.yaml'])

    await expect(
      recoverLandCommit(
        { workspacePath: fixture.root, attemptFingerprint: 'land-attempt-1' },
        { target: fixture.target }
      )
    ).resolves.toEqual({ landed: false })
    const outcome = await executeLandCommit(
      {
        workspacePath: fixture.root,
        attemptFingerprint: 'land-attempt-1',
        message: 'Land pipeline change'
      },
      { target: fixture.target }
    )

    expect(outcome.status).toBe('committed')
    expect(await gitText(fixture.root, ['show', '--format=', '--name-only', 'HEAD'])).toBe(
      'src/result.txt'
    )
    expect(await gitText(fixture.root, ['show', '-s', '--format=%B', 'HEAD'])).toMatch(
      /Land pipeline change\n\nOrca-Heimdall-Attempt: land-attempt-1$/u
    )
    expect(await readFile(join(fixture.root, '.orca', 'pipelines', 'x.yaml'), 'utf8')).toBe(
      'version: 1\n'
    )
    await expect(
      recoverLandCommit(
        { workspacePath: fixture.root, attemptFingerprint: 'land-attempt-1' },
        { target: fixture.target }
      )
    ).resolves.toEqual({ landed: true, headSha: outcome.headSha })
  })

  it('reports nothing-to-commit for a clean worktree and for .orca-only dirt', async () => {
    const fixture = await landingFixture()
    const before = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    await expect(
      executeLandCommit(
        {
          workspacePath: fixture.root,
          attemptFingerprint: 'clean-attempt',
          message: 'No changes'
        },
        { target: fixture.target }
      )
    ).resolves.toEqual({ status: 'nothing-to-commit', headSha: before })

    await mkdir(join(fixture.root, '.orca', 'pipelines'), { recursive: true })
    await writeFile(join(fixture.root, '.orca', 'pipelines', 'only.yaml'), 'name: draft\n')
    const metadataAttempt = await executeLandCommit(
      {
        workspacePath: fixture.root,
        attemptFingerprint: 'metadata-only-attempt',
        message: 'Do not land metadata'
      },
      { target: fixture.target }
    )
    expect(metadataAttempt).toEqual({ status: 'nothing-to-commit', headSha: before })
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('refuses to commit in a folder workspace', async () => {
    const fixture = await landingFixture()
    const folderTarget: ObjectiveWorkspaceTarget = { ...fixture.target, kind: 'folder' }
    await expect(
      executeLandCommit(
        { workspacePath: fixture.root, attemptFingerprint: 'folder-attempt', message: 'No' },
        { target: folderTarget }
      )
    ).rejects.toMatchObject({
      outcome: { effect: 'not-landed', reason: 'git-only-node-in-folder' }
    })
  })
})

describe('pipeline Land executor push recovery', () => {
  it('pushes the captured target and recognizes an already-pushed head without a second push', async () => {
    const fixture = await landingFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'push recovery change\n')
    const committed = await executeLandCommit(
      {
        workspacePath: fixture.root,
        attemptFingerprint: 'push-attempt',
        message: 'Land for push recovery'
      },
      { target: fixture.target }
    )
    if (committed.status !== 'committed') {
      throw new Error('The test fixture did not produce a commit')
    }
    const target = await pushTargetFor(fixture.target)
    const counter = join(fixture.parent, 'pre-push-count')
    const hook = join(fixture.root, '.git', 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\nprintf x >> ${JSON.stringify(counter)}\n`)
    await chmod(hook, 0o755)

    await expect(
      recoverLandPush(
        {
          workspacePath: fixture.root,
          branch: 'main',
          headSha: committed.headSha,
          target
        },
        { target: fixture.target }
      )
    ).resolves.toBe('not-landed')
    const action = {
      workspacePath: fixture.root,
      branch: 'main',
      headSha: committed.headSha,
      target
    }
    await expect(executeLandPush(action, { target: fixture.target })).resolves.toEqual({
      status: 'pushed',
      remoteHeadSha: committed.headSha
    })
    await expect(recoverLandPush(action, { target: fixture.target })).resolves.toBe('landed')
    await expect(executeLandPush(action, { target: fixture.target })).resolves.toEqual({
      status: 'pushed',
      remoteHeadSha: committed.headSha
    })

    expect(await readFile(counter, 'utf8')).toBe('x')
    expect(await gitText(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(committed.headSha)
  })
  it('pushes the observed remote destination while reading the local attached branch', async () => {
    const fixture = await landingFixture()
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'mapped push change\n')
    const committed = await executeLandCommit(
      {
        workspacePath: fixture.root,
        attemptFingerprint: 'mapped-push-attempt',
        message: 'Land to mapped ref'
      },
      { target: fixture.target }
    )
    if (committed.status !== 'committed') {
      throw new Error('The test fixture did not produce a commit')
    }
    await git(fixture.root, ['remote', 'add', 'upstream', fixture.remote])
    await git(fixture.root, ['config', 'branch.main.remote', 'upstream'])
    await git(fixture.root, ['config', 'branch.main.merge', 'refs/heads/published'])
    const target = await pushTargetFor(fixture.target)
    expect(target).toMatchObject({ remote: 'upstream', branch: 'published' })

    await expect(
      executeLandPush(
        {
          workspacePath: fixture.root,
          branch: target.branch,
          headSha: committed.headSha,
          target
        },
        { target: fixture.target }
      )
    ).resolves.toEqual({ status: 'pushed', remoteHeadSha: committed.headSha })
    expect(await gitText(fixture.remote, ['rev-parse', 'refs/heads/published'])).toBe(
      committed.headSha
    )
  })
})

describe('pipeline Land executor hosted reviews', () => {
  it.each(['github', 'gitlab'] as const)(
    'opens and probes one %s review for the pushed head',
    async (providerId) => {
      const fixture = await landingFixture()
      const { headSha, pushTarget } = await commitAndPush(fixture)
      const fake = reviewAccess(providerId, headSha)
      const deps = {
        target: fixture.target,
        forge: fake.forge,
        headSha,
        pushTarget,
        provider: providerId,
        base: 'main'
      }
      await expect(
        executeLandOpenReview(
          {
            workspacePath: fixture.root,
            branch: pushTarget.branch,
            title: 'Land pipeline change',
            body: 'Validated changes',
            draft: false
          },
          deps
        )
      ).resolves.toEqual({
        prUrl:
          providerId === 'github'
            ? `https://${providerId}.test/acme/repo/pull/31`
            : `https://${providerId}.test/acme/repo/merge_requests/31`,
        prNumber: 31,
        branch: pushTarget.branch,
        headSha,
        provider: providerId
      })
      expect(fake.state.createdCount).toBe(1)
      expect(fake.state.reviewReadCount).toBe(2)
      expect(fake.state.createInputs[0]).toMatchObject({
        provider: providerId,
        head: pushTarget.branch,
        base: 'main',
        title: 'Land pipeline change',
        body: 'Validated changes',
        draft: false
      })
      await expect(
        executeLandOpenReview(
          {
            workspacePath: fixture.root,
            branch: pushTarget.branch,
            title: 'Land pipeline change',
            body: 'Validated changes',
            draft: false
          },
          deps
        )
      ).resolves.toMatchObject({ prNumber: 31, headSha })
      expect(fake.state.createdCount).toBe(1)
      await expect(
        recoverLandOpenReview({ workspacePath: fixture.root, branch: pushTarget.branch }, deps)
      ).resolves.toBe('landed')
      expect(fake.state.createdCount).toBe(1)
    }
  )
  it('recovers a review created before its response was lost without creating another', async () => {
    const fixture = await landingFixture()
    const { headSha, pushTarget } = await commitAndPush(fixture)
    const fake = reviewAccess('github', headSha)
    fake.state.loseNextCreateResponse = true
    const input = {
      workspacePath: fixture.root,
      branch: pushTarget.branch,
      title: 'Land pipeline change',
      body: 'Validated changes',
      draft: false
    }
    const deps = {
      target: fixture.target,
      forge: fake.forge,
      headSha,
      pushTarget,
      provider: 'github' as const,
      base: 'main'
    }

    await expect(executeLandOpenReview(input, deps)).resolves.toMatchObject({
      prNumber: 31,
      headSha,
      provider: 'github'
    })
    expect(fake.state.createdCount).toBe(1)
    expect(fake.state.reviewReadCount).toBe(2)
    await expect(
      recoverLandOpenReview({ workspacePath: fixture.root, branch: pushTarget.branch }, deps)
    ).resolves.toBe('landed')
    await expect(executeLandOpenReview(input, deps)).resolves.toMatchObject({
      prNumber: 31,
      headSha,
      provider: 'github'
    })
    expect(fake.state.createdCount).toBe(1)
  })

  it('returns an existing review for the exact head without creating another', async () => {
    const fixture = await landingFixture()
    const { headSha, pushTarget } = await commitAndPush(fixture)
    const existing = reviewInfo('github', headSha)
    const fake = reviewAccess('github', headSha, existing)
    await expect(
      executeLandOpenReview(
        {
          workspacePath: fixture.root,
          branch: pushTarget.branch,
          title: 'Unused title',
          body: 'Unused body',
          draft: false
        },
        {
          target: fixture.target,
          forge: fake.forge,
          headSha,
          pushTarget,
          provider: 'github',
          base: 'main'
        }
      )
    ).resolves.toMatchObject({ prNumber: existing.number, prUrl: existing.url, headSha })
    expect(fake.state.createdCount).toBe(0)
    expect(fake.state.reviewReadCount).toBe(1)
  })

  it('does not create a review when the authoritative pre-probe fails', async () => {
    const fixture = await landingFixture()
    const { headSha, pushTarget } = await commitAndPush(fixture)
    const fake = reviewAccess('github', headSha)
    fake.state.failNextProbe = true
    await expect(
      executeLandOpenReview(
        {
          workspacePath: fixture.root,
          branch: pushTarget.branch,
          title: 'Land pipeline change',
          body: 'Validated changes',
          draft: false
        },
        {
          target: fixture.target,
          forge: fake.forge,
          headSha,
          pushTarget,
          provider: 'github',
          base: 'main'
        }
      )
    ).rejects.toMatchObject({
      outcome: { effect: 'indeterminate', reason: 'hosted-review-probe-failed' }
    })
    expect(fake.state.createdCount).toBe(0)
  })
})

describe('pipeline Land host-routed facts', () => {
  it('runs commit, push, and hosted review through the SSH Git route', async () => {
    const fixture = await landingFixture()
    const runtimeTarget = fixture.target.gitTarget
    if (!runtimeTarget) {
      throw new Error('The test fixture has no Git target')
    }
    const calls: { args: string[]; cwd: string }[] = []
    const sshProvider = {
      async exec(args: string[], cwd: string) {
        calls.push({ args, cwd })
        return await git(fixture.root, args)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec is exercised by the host-routed Objective Git adapter.
    registerSshGitProvider(SSH_CONNECTION_ID, sshProvider as unknown as SshGitProvider)
    const target: ObjectiveWorkspaceTarget = {
      kind: 'git',
      executionHostId: SSH_EXECUTION_HOST,
      workspacePath: '/srv/pipeline-repo',
      fileProvider: null,
      gitTarget: { ...runtimeTarget, executionHostId: SSH_EXECUTION_HOST }
    }
    const facts = await readPipelineLandingFacts({
      target,
      repoKey: 'repo-id',
      forge: reviewAccess('github', 'unavailable').forge
    })
    if (!facts.branch || !facts.headSha || !facts.pushTarget || !facts.hostedReview?.base) {
      throw new Error('The Git host did not provide the required Land facts')
    }
    expect(facts.branch).toBe('main')
    expect(facts.headSha).toBe(await gitText(fixture.root, ['rev-parse', 'HEAD']))
    expect(facts.pushTarget).toMatchObject({ remote: 'origin', branch: 'main' })
    expect(facts.pushTarget.remoteSha).toBe(OBJECTIVE_ABSENT_REMOTE_REF_STATE)
    expect(facts.hostedReview).toEqual({
      provider: 'github',
      repoKey: 'repo-id',
      base: 'main'
    })

    await writeFile(join(fixture.root, 'src', 'result.txt'), 'SSH pipeline change\n')
    const committed = await executeLandCommit(
      {
        workspacePath: target.workspacePath,
        attemptFingerprint: 'ssh-land-attempt',
        message: 'Land through SSH'
      },
      { target }
    )
    if (committed.status !== 'committed') {
      throw new Error('The SSH test fixture did not produce a commit')
    }
    const pushed = await executeLandPush(
      {
        workspacePath: target.workspacePath,
        branch: facts.pushTarget.branch,
        headSha: committed.headSha,
        target: facts.pushTarget
      },
      { target }
    )
    expect(pushed).toEqual({ status: 'pushed', remoteHeadSha: committed.headSha })
    const fake = reviewAccess('github', committed.headSha)
    await expect(
      executeLandOpenReview(
        {
          workspacePath: target.workspacePath,
          branch: facts.pushTarget.branch,
          title: 'Land through SSH',
          body: 'Validated through host Git',
          draft: false
        },
        {
          target,
          forge: fake.forge,
          headSha: committed.headSha,
          pushTarget: facts.pushTarget,
          provider: facts.hostedReview.provider,
          base: facts.hostedReview.base
        }
      )
    ).resolves.toMatchObject({ headSha: committed.headSha, provider: 'github' })

    expect(calls.some((call) => call.args.includes('push'))).toBe(true)
    expect(calls.every((call) => call.cwd === '/srv/pipeline-repo')).toBe(true)
    expect(await gitText(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(committed.headSha)
    expect(fake.state.createdCount).toBe(1)
  })
  it('refuses an unreachable SSH route instead of running Git locally', async () => {
    const fixture = await landingFixture()
    const runtimeTarget = fixture.target.gitTarget
    if (!runtimeTarget) {
      throw new Error('The test fixture has no Git target')
    }
    const before = await gitText(fixture.root, ['rev-parse', 'HEAD'])
    await writeFile(join(fixture.root, 'src', 'result.txt'), 'must stay uncommitted\n')
    const target: ObjectiveWorkspaceTarget = {
      kind: 'git',
      executionHostId: 'ssh:pipeline-land-unreachable',
      workspacePath: fixture.root,
      fileProvider: null,
      gitTarget: {
        ...runtimeTarget,
        executionHostId: 'ssh:pipeline-land-unreachable'
      }
    }
    await expect(
      executeLandCommit(
        {
          workspacePath: fixture.root,
          attemptFingerprint: 'unreachable-attempt',
          message: 'Must not run locally'
        },
        { target }
      )
    ).rejects.toThrow('Remote connection dropped')
    expect(await gitText(fixture.root, ['rev-parse', 'HEAD'])).toBe(before)
    expect(await gitText(fixture.root, ['status', '--porcelain', '--', 'src/result.txt'])).not.toBe(
      ''
    )
  })

  it('binds the external expected state to the captured head SHA', async () => {
    const facts: PipelineLandingFacts = {
      branch: 'feature/pipeline',
      headSha: 'a'.repeat(40),
      pushTarget: { remote: 'origin', branch: 'feature/pipeline', remoteSha: 'before-sha' },
      hostedReview: { provider: 'github', repoKey: 'repo-id', base: 'main' }
    }
    const pushTarget = facts.pushTarget
    if (!pushTarget || !facts.headSha || !facts.branch) {
      throw new Error('The test facts are incomplete')
    }
    const first = landExpectedState('pipeline-land-push', {
      ...facts,
      branch: facts.branch,
      headSha: facts.headSha,
      target: pushTarget
    })
    const second = landExpectedState('pipeline-land-push', {
      ...facts,
      branch: facts.branch,
      headSha: 'b'.repeat(40),
      target: pushTarget
    })
    expect(first).not.toEqual(second)
    expect(first.before).toBe(pushTarget.remoteSha)
    const reviewExpected = landExpectedState('pipeline-land-open-review', {
      ...facts,
      branch: pushTarget.branch,
      headSha: facts.headSha,
      target: pushTarget,
      provider: 'github',
      base: 'main'
    })
    const changedReviewExpected = landExpectedState('pipeline-land-open-review', {
      ...facts,
      branch: pushTarget.branch,
      headSha: 'c'.repeat(40),
      target: pushTarget,
      provider: 'github',
      base: 'main'
    })
    expect(reviewExpected).not.toEqual(changedReviewExpected)
    expect(reviewExpected.before).toBe('no-review')
  })
})
