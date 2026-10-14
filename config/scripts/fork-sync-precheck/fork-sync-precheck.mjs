#!/usr/bin/env node
/**
 * Precheck for the daily "Sync fork with upstream" Orca automation: exits 0 when the run has work,
 * NOTHING_TO_DO_EXIT_CODE when it has none, and any other code when it could not decide.
 *
 * Work means one of: upstream shipped a stable release newer than the last one the fork released
 * on, the newest changelog release never published, or main carries unreleased fork commits. It
 * mirrors the release skill's Step 3 so a skipped run is one that skill would also have ended
 * with "nothing to release".
 *
 * The automation pipes this file from origin/main into node, so it must stay self-contained.
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NOTHING_TO_DO_EXIT_CODE = 10

const FORK_REPO = 'zpyoung/orca'
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const ANCHOR_REF = 'refs/fork-sync-precheck/anchor'

function stableParts(tag) {
  const match = STABLE_TAG.exec(tag)
  return match ? match.slice(1).map(Number) : null
}

export function compareStableTags(a, b) {
  const left = stableParts(a)
  const right = stableParts(b)
  if (!left || !right) {
    throw new Error(`Not a stable tag: ${left ? b : a}`)
  }
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i]
    }
  }
  return 0
}

/** Newest strict vX.Y.Z tag in `git ls-remote --tags --refs` output; throws when there is none. */
export function latestStableTag(lsRemoteOutput) {
  const tags = lsRemoteOutput
    .split('\n')
    .map((line) => line.split('\t')[1]?.replace(/^refs\/tags\//, ''))
    .filter((tag) => tag && STABLE_TAG.test(tag))
  if (tags.length === 0) {
    throw new Error('Upstream listed no stable tags')
  }
  return tags.reduce((newest, tag) => (compareStableTags(tag, newest) > 0 ? tag : newest))
}

/** The frontmatter fields and newest section heading the release skill writes to CHANGELOG.md. */
export function parseChangelog(text) {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const field = (name) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(frontmatter)?.[1]
  const lastReleasedCommit = field('last_released_commit')
  const upstreamSynced = field('upstream_synced')
  const newestVersion = /^## \[([^\]]+)\]/m.exec(text)?.[1]
  if (!lastReleasedCommit || !upstreamSynced || !newestVersion) {
    throw new Error('CHANGELOG.md is missing last_released_commit, upstream_synced, or a release')
  }
  return { lastReleasedCommit, upstreamSynced, newestTag: `v${newestVersion}` }
}

/** Drops commits the release skill never writes changelog entries for. */
export function forkCommitsNeedingRelease(logOutput) {
  return logOutput
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, ...subject] = line.split('\t')
      return { sha, author, subject: subject.join('\t') }
    })
    .filter(
      (commit) =>
        !commit.author.includes('[bot]') && !commit.subject.startsWith('docs(changelog): release')
    )
}

/** Each reason the automation should run; an empty list means there is nothing to do. */
export function reasonsToRun({ latestUpstream, changelog, newestRelease, forkCommits }) {
  const reasons = []
  if (compareStableTags(latestUpstream, changelog.upstreamSynced) > 0) {
    reasons.push(
      `upstream ${latestUpstream} is newer than the last released anchor ${changelog.upstreamSynced}`
    )
  }
  if (newestRelease !== 'published') {
    reasons.push(`${changelog.newestTag} is ${newestRelease}, not published`)
  }
  if (forkCommits.length > 0) {
    reasons.push(
      `${forkCommits.length} unreleased fork commit(s), newest: ${forkCommits[0].subject}`
    )
  }
  return reasons
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options
  })
}

function newestReleaseState(tag) {
  // an ambient GITHUB_TOKEN overrides gh's keyring login, which is the one with access to the fork
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  try {
    const isDraft = run(
      'gh',
      ['release', 'view', tag, '--repo', FORK_REPO, '--json', 'isDraft', '--jq', '.isDraft'],
      { env }
    ).trim()
    return isDraft === 'false' ? 'published' : 'a draft'
  } catch (error) {
    if (/release not found/i.test(String(error.stderr))) {
      return 'missing'
    }
    throw error
  }
}

function main() {
  const changelog = parseChangelog(run('git', ['show', 'origin/main:CHANGELOG.md']))
  // a truncated listing would silently report an older tag as upstream's newest
  const latestUpstream = latestStableTag(
    run('git', ['ls-remote', '--tags', '--refs', 'upstream', 'refs/tags/v*'])
  )
  run('git', ['fetch', '--quiet', '--no-tags', 'upstream', 'main'])
  // a private ref, because a re-cut upstream tag can collide with a stale local one
  run('git', [
    'fetch',
    '--quiet',
    '--no-tags',
    'upstream',
    `+refs/tags/${changelog.upstreamSynced}:${ANCHOR_REF}`
  ])
  run('git', ['cat-file', '-e', `${changelog.lastReleasedCommit}^{commit}`])
  const forkCommits = forkCommitsNeedingRelease(
    run('git', [
      'log',
      '--no-merges',
      '--format=%H%x09%an%x09%s',
      `${changelog.lastReleasedCommit}..origin/main`,
      '^upstream/main',
      `^${ANCHOR_REF}`
    ])
  )
  const reasons = reasonsToRun({
    latestUpstream,
    changelog,
    newestRelease: newestReleaseState(changelog.newestTag),
    forkCommits
  })
  if (reasons.length === 0) {
    console.log(
      `Nothing to do: upstream ${latestUpstream} is released as ${changelog.newestTag}, ` +
        'which is published, and main has no unreleased fork commits.'
    )
    process.exit(NOTHING_TO_DO_EXIT_CODE)
  }
  for (const reason of reasons) {
    console.log(`Run: ${reason}`)
  }
}

const entry = process.argv[1]
if (entry === '-' || (entry && import.meta.url === pathToFileURL(resolve(entry)).href)) {
  main()
}
