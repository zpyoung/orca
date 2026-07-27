#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function gitLines(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// Why EXACTLY two digits: `zyNN` is a single alphanumeric semver identifier, so
// it compares as a string. Fixed width keeps string order and numeric order
// identical (zy01 < zy02 < ... < zy99). Mixed widths do not — `zy100` sorts
// below `zy99`, and `zy1` below `zy01` — so anything but two digits is refused
// rather than silently mis-ranked. Ceiling is 99 cuts per rc, far above the
// handful a daily sync cadence can produce.
const FORK_RC_PATTERN = /^(\d+)\.zy(\d{2})(?:\s|$)/

// Why only `.zy<NN>` counts: this fork inherits upstream's `release: vX-rc.N`
// subjects and tags through every sync, so counting them would pin the gate to
// upstream's series and refuse every fork cut at its own merge-base anchor.
// Fork releases are the only ones this repo's clients can install, so the
// series that must stay monotonic is the `.zy` one. A bare rc tag on this fork
// is therefore treated as upstream's, not ours — which is why this fork must
// never cut a bare (suffix-less) release of its own.
function parseForkRc(base, value, subjectPrefix = '') {
  const prefix = `${subjectPrefix}v${base}-rc.`
  if (!value.startsWith(prefix)) {
    return null
  }

  const match = FORK_RC_PATTERN.exec(value.slice(prefix.length))
  return match ? { rc: Number(match[1]), suffix: Number(match[2]) } : null
}

export function forkRcNumberFromTag(base, tag) {
  return parseForkRc(base, tag)?.rc ?? null
}

// Why the subject form matters: it is the only record left once a tag is
// deleted, and that is exactly when release-cut's explicit-version gate reads
// this.
export function forkRcNumberFromReleaseSubject(base, subject) {
  return parseForkRc(base, subject, 'release: ')?.rc ?? null
}

export function forkSuffixFromTag(base, rc, tag) {
  const parsed = parseForkRc(base, tag)
  return parsed && parsed.rc === rc ? parsed.suffix : null
}

export function forkSuffixFromReleaseSubject(base, rc, subject) {
  const parsed = parseForkRc(base, subject, 'release: ')
  return parsed && parsed.rc === rc ? parsed.suffix : null
}

function highestFor(base, cwd, fromTag, fromSubject) {
  const numbers = []

  for (const tag of gitLines(['tag', '--list', `v${base}-rc.*`], cwd)) {
    const value = fromTag(tag)
    if (value !== null) {
      numbers.push(value)
    }
  }

  const logRefs = ['HEAD', 'origin/main'].filter(
    (ref) => gitLines(['rev-parse', '--verify', '--quiet', ref], cwd).length > 0
  )
  if (logRefs.length > 0) {
    for (const subject of gitLines(['log', '--format=%s', ...logRefs], cwd)) {
      const value = fromSubject(subject)
      if (value !== null) {
        numbers.push(value)
      }
    }
  }

  return numbers.length === 0 ? null : Math.max(...numbers)
}

export function highestRcForBase(base, { cwd = process.cwd() } = {}) {
  return highestFor(
    base,
    cwd,
    (tag) => forkRcNumberFromTag(base, tag),
    (subject) => forkRcNumberFromReleaseSubject(base, subject)
  )
}

// Why this exists: release-cut's explicit-version gate compares rc numbers
// alone, which would refuse a second fork cut anchored on the same upstream rc.
// The fork's real ordering is (rc, suffix), so the gate consults this to allow
// an equal rc whose suffix strictly advances — keeping the rc position free to
// name the upstream anchor it was built on.
export function highestForkSuffixForRc(base, rc, { cwd = process.cwd() } = {}) {
  return highestFor(
    base,
    cwd,
    (tag) => forkSuffixFromTag(base, rc, tag),
    (subject) => forkSuffixFromReleaseSubject(base, rc, subject)
  )
}

function main() {
  const base = process.argv[2]
  if (!base) {
    throw new Error('Usage: node config/scripts/release-rc-history.mjs <base-version> [--rc <n>]')
  }

  const rcFlagIndex = process.argv.indexOf('--rc')
  const highest =
    rcFlagIndex === -1
      ? highestRcForBase(base)
      : highestForkSuffixForRc(base, Number(process.argv[rcFlagIndex + 1]))

  if (highest !== null) {
    process.stdout.write(String(highest))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
