import { describe, expect, it } from 'vitest'
import {
  compareStableTags,
  forkCommitsNeedingRelease,
  latestStableTag,
  parseChangelog,
  reasonsToRun
} from './fork-sync-precheck.mjs'

const changelog = `---
last_released_commit: ad2dc09421a8a4a6abf136d6667c81877d99dae3
upstream_synced: v1.4.224
---

# Changelog

## [1.4.225-rc.0.zy02] - 2026-10-14

Synced to upstream [v1.4.224](https://github.com/stablyai/orca/releases/tag/v1.4.224).

## [1.4.225-rc.0.zy01] - 2026-10-12
`

const settled = {
  latestUpstream: 'v1.4.224',
  changelog: parseChangelog(changelog),
  newestRelease: 'published',
  forkCommits: []
}

describe('latestStableTag', () => {
  it('picks the numerically newest stable tag and ignores prereleases and fork tags', () => {
    const listing = [
      'a\trefs/tags/v1.4.9',
      'b\trefs/tags/v1.4.10',
      'c\trefs/tags/v1.4.11-rc.0',
      'd\trefs/tags/v1.4.225-rc.0.zy02',
      ''
    ].join('\n')
    expect(latestStableTag(listing)).toBe('v1.4.10')
  })

  it('throws on a listing with no stable tag rather than guessing', () => {
    expect(() => latestStableTag('a\trefs/tags/v1.4.11-rc.0\n')).toThrow()
  })
})

describe('compareStableTags', () => {
  it('compares each component numerically', () => {
    expect(compareStableTags('v1.4.224', 'v1.4.99')).toBeGreaterThan(0)
    expect(compareStableTags('v1.4.224', 'v1.4.224')).toBe(0)
  })
})

describe('parseChangelog', () => {
  it('reads the frontmatter and the newest section as a tag', () => {
    expect(parseChangelog(changelog)).toEqual({
      lastReleasedCommit: 'ad2dc09421a8a4a6abf136d6667c81877d99dae3',
      upstreamSynced: 'v1.4.224',
      newestTag: 'v1.4.225-rc.0.zy02'
    })
  })

  it('throws when the frontmatter is incomplete', () => {
    expect(() => parseChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n')).toThrow()
  })
})

describe('forkCommitsNeedingRelease', () => {
  it("drops bot commits and the release skill's own changelog commits", () => {
    const log = [
      'aaa\tgithub-actions[bot]\trelease: v1.4.225-rc.0.zy02',
      'bbb\tzpyoung\tdocs(changelog): release v1.4.225-rc.0.zy02',
      'ccc\tzpyoung\tfix(terminal): keep focus\tafter paste',
      ''
    ].join('\n')
    expect(forkCommitsNeedingRelease(log)).toEqual([
      { sha: 'ccc', author: 'zpyoung', subject: 'fix(terminal): keep focus\tafter paste' }
    ])
  })
})

describe('reasonsToRun', () => {
  it('finds nothing to do when upstream is released, published, and main has no fork work', () => {
    expect(reasonsToRun(settled)).toEqual([])
  })

  it('runs for a newer upstream stable release', () => {
    expect(reasonsToRun({ ...settled, latestUpstream: 'v1.4.225' })).toHaveLength(1)
  })

  it('runs when the newest release is a draft or was never created', () => {
    expect(reasonsToRun({ ...settled, newestRelease: 'a draft' })).toHaveLength(1)
    expect(reasonsToRun({ ...settled, newestRelease: 'missing' })).toHaveLength(1)
  })

  it('runs for unreleased fork commits', () => {
    const forkCommits = [{ sha: 'ccc', author: 'zpyoung', subject: 'fix: x' }]
    expect(reasonsToRun({ ...settled, forkCommits })).toHaveLength(1)
  })

  // an upstream tag retraction can leave the fork ahead; that is not work
  it("does not run when the fork is ahead of upstream's newest stable tag", () => {
    expect(reasonsToRun({ ...settled, latestUpstream: 'v1.4.223' })).toEqual([])
  })
})
