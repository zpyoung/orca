import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { executeHostedReviewBranchUpdate } from '../../shared/fork-hosted-review-sitter/git-branch-update'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' })
  return { stdout: result.stdout, stderr: result.stderr }
}

async function commitFile(
  repo: string,
  name: string,
  contents: string,
  message: string
): Promise<string> {
  await execFileAsync('node', [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(join(repo, name))}, ${JSON.stringify(contents)})`
  ])
  await git(repo, ['add', '--', name])
  await git(repo, ['commit', '-m', message])
  return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
}

describe('executeHostedReviewBranchUpdate', () => {
  let root: string
  let bare: string
  let review: string
  let producer: string
  let reviewHead: string
  let baseHead: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-sitter-update-'))
    bare = join(root, 'remote.git')
    review = join(root, 'review')
    producer = join(root, 'producer')
    await git(root, ['init', '--bare', bare])
    await git(root, ['clone', bare, producer])
    await git(producer, ['config', 'user.email', 'sitter@example.test'])
    await git(producer, ['config', 'user.name', 'Sitter Test'])
    await git(producer, ['switch', '-c', 'main'])
    await commitFile(producer, 'base.txt', 'base\n', 'base')
    await git(producer, ['push', '-u', 'origin', 'main'])
    await git(root, ['clone', '--branch', 'main', bare, review])
    await git(review, ['config', 'user.email', 'sitter@example.test'])
    await git(review, ['config', 'user.name', 'Sitter Test'])
    await git(review, ['switch', '-c', 'feature'])
    reviewHead = await commitFile(review, 'feature.txt', 'feature\n', 'feature')
    await git(review, ['push', '-u', 'origin', 'feature'])
    baseHead = await commitFile(producer, 'base.txt', 'base moved\n', 'move base')
    await git(producer, ['push', 'origin', 'main'])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('merges the exact base and publishes with a non-force push', async () => {
    const result = await executeHostedReviewBranchUpdate(
      (args) => git(review, args),
      new GitCapabilityCache(),
      {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      }
    )

    const remoteHead = (
      await git(review, ['ls-remote', '--heads', 'origin', 'refs/heads/feature'])
    ).stdout
      .trim()
      .split(/\s+/)[0]
    expect(remoteHead).toBe(result.resultingHeadSha)
    await expect(
      git(review, ['merge-base', '--is-ancestor', reviewHead, remoteHead!])
    ).resolves.toBeDefined()
    await expect(
      git(review, ['merge-base', '--is-ancestor', baseHead, remoteHead!])
    ).resolves.toBeDefined()
  })

  it('rejects a stale provider head before changing the worktree', async () => {
    await expect(
      executeHostedReviewBranchUpdate((args) => git(review, args), new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: baseHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      })
    ).rejects.toThrow('Review head changed')
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })

  it('rewinds the worktree when the publish push is rejected', async () => {
    // A server-side rejection is the only way to fail the push after the merge already landed.
    const hook = join(bare, 'hooks', 'pre-receive')
    await execFileAsync('node', [
      '-e',
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(hook)}, '#!/bin/sh\\nexit 1\\n');fs.chmodSync(${JSON.stringify(hook)}, 0o755)`
    ])

    await expect(
      executeHostedReviewBranchUpdate((args) => git(review, args), new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: baseHead,
        mode: 'merge-base-update'
      })
    ).rejects.toThrow()
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
    await expect(git(review, ['status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })
  })

  it('rejects a moved base before creating an update commit', async () => {
    await expect(
      executeHostedReviewBranchUpdate((args) => git(review, args), new GitCapabilityCache(), {
        worktreePath: review,
        branch: 'feature',
        pushRemote: bare,
        baseRef: 'origin/main',
        expectedHeadSha: reviewHead,
        expectedBaseSha: reviewHead,
        mode: 'merge-base-update'
      })
    ).rejects.toThrow('Review base changed')
    await expect(git(review, ['rev-parse', 'HEAD'])).resolves.toMatchObject({
      stdout: `${reviewHead}\n`
    })
  })
})
