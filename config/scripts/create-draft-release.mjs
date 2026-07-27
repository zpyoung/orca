#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const MAX_RELEASE_BODY_LENGTH = 120_000
const TRUNCATION_NOTICE =
  '\n\n---\nRelease notes were truncated because GitHub release bodies are limited to 125,000 characters.'
// Fork builds append `.zy<NN>` to an rc tag so they sort above their upstream
// anchor and below upstream's next rc. Only rc tags carry the suffix.
// Why `\d{2,}` and not `\d+`: the counter is zero-padded, and semver compares
// alphanumeric identifiers as strings — `zy01` and `zy1` are distinct tags that
// both parse to 1, so accepting the unpadded form would rank them equal here
// while semver ranks `zy01` below `zy1`.
const DESKTOP_RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+)(?:\.zy(\d{2,}))?)?$/

export function parseDesktopReleaseTag(tag) {
  const match = DESKTOP_RELEASE_TAG_PATTERN.exec(tag)
  if (!match) {
    return null
  }
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[4] === undefined ? null : Number(match[4]),
    fork: match[5] === undefined ? null : Number(match[5])
  }
}

function compareDesktopReleaseTags(a, b) {
  const versionDiff = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (versionDiff !== 0) {
    return versionDiff
  }
  if (a.rc !== b.rc) {
    // Why: a stable release outranks every rc of the same version.
    if (a.rc === null) {
      return 1
    }
    if (b.rc === null) {
      return -1
    }
    return a.rc - b.rc
  }
  // Why: inverse of the rc rule — a fork build outranks the bare rc it is built on.
  if (a.fork === b.fork) {
    return 0
  }
  if (a.fork === null) {
    return -1
  }
  if (b.fork === null) {
    return 1
  }
  return a.fork - b.fork
}

export function latestPreviousPublishedDesktopReleaseTag(releases, tag) {
  const current = parseDesktopReleaseTag(tag)
  if (!current) {
    return ''
  }
  const previousReleases = releases
    .filter((release) => release?.draft === false && typeof release.tag_name === 'string')
    .map((release) => parseDesktopReleaseTag(release.tag_name))
    .filter((candidate) => candidate && candidate.tag !== current.tag)
    .filter((candidate) => compareDesktopReleaseTags(candidate, current) < 0)
    // Why: public changelogs should be bounded by releases users could see;
    // stable releases summarize since the prior stable, not the latest RC.
    .filter((candidate) => current.rc !== null || candidate.rc === null)
    .sort(compareDesktopReleaseTags)
  return previousReleases.at(-1)?.tag ?? ''
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION
  }
}

async function githubJson(fetchImpl, url, token, options = {}) {
  const res = await fetchImpl(url, {
    ...options,
    headers: {
      ...githubHeaders(token),
      ...options.headers
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function fetchRepoReleases(repo, token, fetchImpl) {
  const releases = []
  for (let page = 1; ; page += 1) {
    const pageReleases = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      token
    )
    if (!Array.isArray(pageReleases)) {
      throw new Error(`GitHub releases response page ${page} for ${repo} was not an array`)
    }
    releases.push(...pageReleases)
    if (pageReleases.length < 100) {
      break
    }
  }
  return releases
}

export function truncateReleaseBody(body, maxLength = MAX_RELEASE_BODY_LENGTH) {
  if (body.length <= maxLength) {
    return body
  }

  const availableLength = maxLength - TRUNCATION_NOTICE.length
  if (availableLength <= 0) {
    throw new Error('Release truncation notice is longer than the maximum release body length')
  }

  return `${body.slice(0, availableLength).trimEnd()}${TRUNCATION_NOTICE}`
}

// Why: the release page should lead with what this fork changed; GitHub's
// generated notes only describe the upstream commits the tag inherited.
export function extractChangelogSection(changelog, tag) {
  if (typeof changelog !== 'string' || !changelog) {
    return ''
  }

  const version = tag.replace(/^v/, '')
  const lines = changelog.split('\n')
  const startIndex = lines.findIndex(
    (line) => line.trimEnd() === `## [${version}]` || line.startsWith(`## [${version}] `)
  )
  if (startIndex === -1) {
    return ''
  }

  const rest = lines.slice(startIndex + 1)
  const endOffset = rest.findIndex((line) => line.startsWith('## '))
  const section = endOffset === -1 ? rest : rest.slice(0, endOffset)
  return section.join('\n').trim()
}

function readChangelogFile(path = 'CHANGELOG.md') {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Why: a missing or unreadable changelog must degrade to generated notes,
    // never fail a release that has already been tagged.
    return ''
  }
}

export async function createDraftRelease({
  repo,
  tag,
  token,
  fetchImpl = fetch,
  log = console.log,
  readChangelog = readChangelogFile
}) {
  if (!repo) {
    throw new Error('repo is required')
  }
  if (!tag) {
    throw new Error('tag is required')
  }
  if (!token) {
    throw new Error('token is required')
  }

  const previousTag = latestPreviousPublishedDesktopReleaseTag(
    await fetchRepoReleases(repo, token, fetchImpl),
    tag
  )
  const generateNotesBody = {
    tag_name: tag,
    target_commitish: tag,
    ...(previousTag ? { previous_tag_name: previousTag } : {})
  }

  // Why: GitHub's generate-notes baseline ignores draft releases, so pass the
  // previous public changelog boundary explicitly.
  const releaseNotes = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases/generate-notes`,
    token,
    {
      method: 'POST',
      body: JSON.stringify(generateNotesBody)
    }
  )

  const generatedBody = typeof releaseNotes.body === 'string' ? releaseNotes.body : ''
  const changelogSection = extractChangelogSection(readChangelog(), tag)
  // Why: changelog first so it survives truncation, which trims from the end.
  const fullBody = changelogSection
    ? `${changelogSection}\n\n---\n\n${generatedBody}`
    : generatedBody
  const body = truncateReleaseBody(fullBody)
  const name =
    typeof releaseNotes.name === 'string' && releaseNotes.name.length > 0 ? releaseNotes.name : tag
  const prerelease = tag.includes('-rc.')

  // Why: GitHub's generated release notes can exceed the release body API
  // limit, so create with a bounded body. Omit target_commitish because the
  // release-cut tag already exists and GitHub rejects the tag name there.
  await githubJson(fetchImpl, `https://api.github.com/repos/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name,
      body,
      draft: true,
      prerelease
    })
  })

  const source = changelogSection ? 'changelog + generated notes' : 'generated notes'
  if (fullBody.length !== body.length) {
    log(`Created draft release ${tag} with truncated ${source} (${body.length} chars).`)
  } else {
    log(`Created draft release ${tag} with ${source} (${body.length} chars).`)
  }
}

async function main() {
  const tag = process.argv[2]
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'stablyai/orca'
  await createDraftRelease({ repo, tag, token })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
