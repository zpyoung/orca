import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseTagRows, pickComparisonTag } from '../../.github/scripts/check-fork-ownership.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const guardScript = join(projectDir, '.github/scripts/check-fork-ownership.mjs')
// must match the env var name check-fork-ownership.mjs reads to bypass its network call
const UPSTREAM_REMOTE_OVERRIDE_ENV = 'CHECK_FORK_OWNERSHIP_UPSTREAM_REMOTE'
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-fork-ownership-guard-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'fork-ownership-guard-test@example.com'])
  git(root, ['config', 'user.name', 'Fork Ownership Guard Test'])
  return root
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

function removeFiles(root, paths) {
  for (const relativePath of paths) {
    rmSync(join(root, relativePath), { force: true })
  }
}

function commitAll(root, message) {
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function tagAt(root, name, sha) {
  git(root, ['tag', name, sha])
}

function baseManifest(overrides = {}) {
  return { features: [], seams: [], exceptions: [], ...overrides }
}

// a seam file whose residual budget the caller controls, tagged at v1.4.184
function buildResidualFixture(budget) {
  const root = initRepo()
  writeManifest(root, baseManifest())
  writeFiles(root, { 'src/budgeted.ts': 'const a = 1\n' })
  const tagCommit = commitAll(root, 'tag-commit')
  tagAt(root, 'v1.4.184', tagCommit)

  writeManifest(
    root,
    baseManifest({
      seams: [
        {
          path: 'src/budgeted.ts',
          feature: 'fork-infra',
          kind: 'passthrough',
          lines: ['const b = 2']
        }
      ],
      residuals: { 'src/budgeted.ts': budget }
    })
  )
  writeFiles(root, { 'src/budgeted.ts': 'const a = 1\nconst b = 2\n' })
  return { root, tagCommit, head: commitAll(root, 'fork-edit') }
}

function writeManifest(root, manifest) {
  writeFiles(root, { 'config/fork-ownership.json': JSON.stringify(manifest, null, 2) })
}

// builds one tagged commit (v1.4.184) plus, only if atBase adds something, a second
// commit on top of it; callers that don't need a distinct base reuse the tag commit
function buildFixture({ manifest = {}, atTag = {}, atBase = {} } = {}) {
  const root = initRepo()
  writeManifest(root, baseManifest(manifest))
  writeFiles(root, atTag)
  const tagCommit = commitAll(root, 'tag-commit')
  tagAt(root, 'v1.4.184', tagCommit)
  if (Object.keys(atBase).length === 0) {
    return { root, tagCommit, base: tagCommit }
  }
  writeFiles(root, atBase)
  const base = commitAll(root, 'base')
  return { root, tagCommit, base }
}

function runGuard(root, baseSha, headSha, { upstreamRemote = root } = {}) {
  return spawnSync(process.execPath, [guardScript, baseSha, headSha], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, [UPSTREAM_REMOTE_OVERRIDE_ENV]: upstreamRemote }
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('tag row parsing and comparison-tag selection (pure, no git)', () => {
  it('sorts by numeric version segments, not lexically', () => {
    const rows = [
      'sha9\trefs/tags/v1.4.9',
      'sha18\trefs/tags/v1.4.18',
      'sha180\trefs/tags/v1.4.180'
    ].join('\n')

    const picked = pickComparisonTag(rows, 'head-sha', () => true)

    expect(picked.name).toBe('v1.4.180')
  })

  it('excludes fork-styled tags (-rc / .zy) from candidates', () => {
    const rows = ['sha-fork\trefs/tags/v1.4.185-rc.0.zy01', 'sha-stable\trefs/tags/v1.4.184'].join(
      '\n'
    )

    const picked = pickComparisonTag(rows, 'head-sha', () => true)

    expect(picked.name).toBe('v1.4.184')
  })

  it('prefers the peeled commit row over the tag-object row for an annotated tag', () => {
    const rows = [
      'tag-object-sha\trefs/tags/v1.4.184',
      'peeled-commit-sha\trefs/tags/v1.4.184^{}'
    ].join('\n')

    const tags = parseTagRows(rows)

    expect(tags.get('v1.4.184')).toBe('peeled-commit-sha')
  })

  it('returns null when no candidate satisfies the ancestor check', () => {
    const picked = pickComparisonTag('sha\trefs/tags/v1.4.184', 'head-sha', () => false)

    expect(picked).toBeNull()
  })
})

describe('comparison-ref resolution (real git, network bypassed via local remote)', () => {
  function buildTaggedHistory() {
    const root = initRepo()
    writeManifest(root, baseManifest())
    const early = commitAll(root, 'init')
    tagAt(root, 'v1.4.18', early)
    writeFiles(root, { 'docs/marker.md': 'late\n' })
    const late = commitAll(root, 'v-late')
    tagAt(root, 'v1.4.184', late)
    removeFiles(root, ['docs/marker.md'])
    const base = commitAll(root, 'delete-marker')
    return { root, early, late, base }
  }

  function buildDivergedHistory() {
    const root = initRepo()
    writeManifest(root, baseManifest())
    const early = commitAll(root, 'init')
    tagAt(root, 'v1.4.18', early)

    git(root, ['checkout', '-b', 'fork-branch', early])
    writeFiles(root, { 'fork-only.md': 'fork\n' })
    const base = commitAll(root, 'fork-only-commit')

    git(root, ['checkout', '-b', 'upstream-branch', early])
    writeFiles(root, { 'docs/marker.md': 'late\n' })
    const late = commitAll(root, 'v-late')
    tagAt(root, 'v1.4.184', late)

    git(root, ['checkout', 'fork-branch'])
    return { root, base }
  }

  // proves the newest tag wins by re-adding, after the tag, a file that only exists in
  // the newest tag's tree: coverage passes iff the guard picked that newest tag
  it('picks the newest reachable stable tag for an ordinary PR', () => {
    const { root, base } = buildTaggedHistory()
    writeFiles(root, { 'docs/marker.md': 're-added\n' })
    const head = commitAll(root, 're-add-marker')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('guard passed')
  })

  it('picks the tag a sync merge brings in for the first time, sitting exactly at HEAD', () => {
    const { root, base } = buildDivergedHistory()
    execFileSync('git', ['merge', '--no-ff', '--no-edit', 'upstream-branch'], { cwd: root })
    const head = git(root, ['rev-parse', 'HEAD'])

    const result = runGuard(root, base, head)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('guard passed')
  })

  it('picks the tag a sync merge brings in even with fixup commits on top', () => {
    const { root, base } = buildDivergedHistory()
    execFileSync('git', ['merge', '--no-ff', '--no-edit', 'upstream-branch'], { cwd: root })
    writeFiles(root, { 'fork-only.md': 'fixup 1\n' })
    commitAll(root, 'fixup-1')
    writeFiles(root, { 'fork-only.md': 'fixup 2\n' })
    const head = commitAll(root, 'fixup-2')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('guard passed')
  })

  it('exits 2 when no stable tag is reachable from HEAD', () => {
    const root = initRepo()
    writeManifest(root, baseManifest())
    const base = commitAll(root, 'init')
    const mainBranch = git(root, ['branch', '--show-current'])

    git(root, ['checkout', '-b', 'unrelated', base])
    writeFiles(root, { 'unrelated.md': 'x\n' })
    tagAt(root, 'v1.4.184', commitAll(root, 'unrelated-tag-commit'))

    git(root, ['checkout', mainBranch])
    writeFiles(root, { 'feature.md': 'x\n' })
    const head = commitAll(root, 'feature-commit')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('reachable')
  })

  // upstream keeps tagging after the fork's last sync, so its newest stable tags name commits
  // this clone has never fetched; probing one must not abort the whole guard
  it('skips an upstream stable tag whose commit this clone has never fetched', () => {
    const upstream = initRepo()
    writeManifest(upstream, baseManifest())
    writeFiles(upstream, { 'docs/marker.md': 'tagged\n' })
    const tagCommit = commitAll(upstream, 'tag-commit')
    tagAt(upstream, 'v1.4.184', tagCommit)

    const root = mkdtempSync(join(tmpdir(), 'orca-fork-ownership-guard-'))
    tempDirs.push(root)
    execFileSync('git', ['clone', '--quiet', upstream, root])
    git(root, ['config', 'user.email', 'fork-ownership-guard-test@example.com'])
    git(root, ['config', 'user.name', 'Fork Ownership Guard Test'])

    writeFiles(upstream, { 'docs/marker.md': 'newer\n' })
    tagAt(upstream, 'v1.4.185', commitAll(upstream, 'newer-tag-commit'))

    writeFiles(root, { 'docs/marker.md': 'fork\n' })
    const head = commitAll(root, 'fork-commit')

    const result = runGuard(root, tagCommit, head, { upstreamRemote: upstream })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('guard passed')
  })

  it('passes when a seam file matches its recorded residual budget', () => {
    const { root, tagCommit, head } = buildResidualFixture({ added: 1, removed: 0 })

    const result = runGuard(root, tagCommit, head)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('guard passed')
  })

  // seam `lines` assert presence only, so an undeclared edit is invisible without the budget
  it('reports a seam file that drifted from its recorded residual budget', () => {
    const { root, tagCommit, head } = buildResidualFixture({ added: 99, removed: 0 })

    const result = runGuard(root, tagCommit, head)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('residual-budget')
    expect(result.stdout).toContain('measured +1/-0')
  })

  // a deletion has no line to declare, so the budget is the only thing that can catch one
  it('reports an upstream line deleted from a seam file', () => {
    const { root } = buildResidualFixture({ added: 1, removed: 0 })
    writeFiles(root, { 'src/budgeted.ts': 'const b = 2\n' })
    const head = commitAll(root, 'delete-upstream-line')

    const result = runGuard(root, git(root, ['rev-parse', 'v1.4.184']), head)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('residual-budget')
    expect(result.stdout).toContain('measured +1/-1')
  })

  it('exits 2 when the upstream tag listing is empty', () => {
    const root = initRepo()
    writeManifest(root, baseManifest())
    const base = commitAll(root, 'init')
    writeFiles(root, { 'feature.md': 'x\n' })
    const head = commitAll(root, 'feature-commit')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/empty/)
  })

  it('exits 2 when ls-remote itself fails (a dropped connection or bad remote)', () => {
    const root = initRepo()
    writeManifest(root, baseManifest())
    const base = commitAll(root, 'init')
    writeFiles(root, { 'feature.md': 'x\n' })
    const head = commitAll(root, 'feature-commit')

    const result = runGuard(root, base, head, { upstreamRemote: join(root, 'does-not-exist') })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('failed to list upstream tags')
  })
})

describe('coverage rule', () => {
  it('flags a new file that is not declared in the manifest', () => {
    const { root, base } = buildFixture({})
    writeFiles(root, { 'src/new-undeclared.ts': 'x\n' })
    const head = commitAll(root, 'add-undeclared')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[coverage]')
    expect(result.stdout).toContain('src/new-undeclared.ts')
  })

  it('allows a new file declared as an exception', () => {
    const { root, base } = buildFixture({
      manifest: {
        exceptions: [{ path: 'src/new-declared.ts', reason: 'fork-owned', status: 'permanent' }]
      }
    })
    writeFiles(root, { 'src/new-declared.ts': 'x\n' })
    const head = commitAll(root, 'add-declared')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(0)
  })

  // with rename detection on, this shows as 'R' and --diff-filter=A would miss it entirely
  it('still flags a rename+modify into an undeclared path with rename detection configured', () => {
    const oldContent = 'const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = 5\n'
    const newContent = `${oldContent}const f = 6\n`
    const { root, base } = buildFixture({ atTag: { 'src/old-name.ts': oldContent } })
    git(root, ['config', 'diff.renames', 'true'])
    removeFiles(root, ['src/old-name.ts'])
    writeFiles(root, { 'src/new-name.ts': newContent })
    const head = commitAll(root, 'rename-and-modify')

    const result = runGuard(root, base, head)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[coverage]')
    expect(result.stdout).toContain('src/new-name.ts')
  })
})

describe('stale entry rule', () => {
  it('flags a feature glob that matches nothing at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: { features: [{ name: 'ghost-feature', purpose: 'x', globs: ['src/ghost/**'] }] }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[stale-entry]')
    expect(result.stdout).toContain('ghost-feature')
  })

  it('allows a feature glob that matches a real path at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: { features: [{ name: 'live-feature', purpose: 'x', globs: ['src/live/**'] }] },
      atBase: { 'src/live/file.ts': 'x\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(0)
  })

  it('flags a declared seam whose path no longer exists at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          {
            path: 'src/gone-seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const X = 1']
          }
        ]
      }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[stale-entry]')
    expect(result.stdout).toContain('src/gone-seam.ts')
  })

  it('flags an exception declared deleted but present at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: {
        exceptions: [
          { path: 'src/should-be-gone.ts', reason: 'x', status: 'permanent', deleted: true }
        ]
      },
      atTag: { 'src/should-be-gone.ts': 'still here\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[stale-entry]')
    expect(result.stdout).toContain('declared deleted but present')
  })

  it('flags a manifest that violates a loader invariant', () => {
    const { root, tagCommit } = buildFixture({})
    writeFiles(root, {
      'config/fork-ownership.json': JSON.stringify({
        features: [],
        seams: [],
        exceptions: [{ path: 'x', reason: 'y', status: 'not-a-real-status' }]
      })
    })
    const head = commitAll(root, 'bad-manifest')

    const result = runGuard(root, tagCommit, head)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[stale-entry]')
    expect(result.stdout).toContain('manifest is invalid')
  })

  it('allows an exception declared deleted whose path is genuinely absent at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: {
        exceptions: [{ path: 'src/long-gone.ts', reason: 'x', status: 'permanent', deleted: true }]
      }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(0)
  })

  it('does not flag a non-ASCII seam path that is present at HEAD', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          {
            path: 'src/café-seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const MARKER = true']
          }
        ]
      },
      atTag: { 'src/café-seam.ts': 'const MARKER = true\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(0)
  })
})

describe('silent capture rule', () => {
  it('flags a feature-glob path that also exists upstream with no seam or exception', () => {
    const { root, base } = buildFixture({
      manifest: {
        features: [{ name: 'captured-feature', purpose: 'x', globs: ['src/captured/**'] }]
      },
      atTag: { 'src/captured/file.ts': 'upstream version\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[silent-capture]')
    expect(result.stdout).toContain('src/captured/file.ts')
  })

  it('allows a feature-glob path that is also declared as a seam', () => {
    const { root, base } = buildFixture({
      manifest: {
        features: [{ name: 'captured-feature', purpose: 'x', globs: ['src/captured/**'] }],
        seams: [
          {
            path: 'src/captured/file.ts',
            feature: 'captured-feature',
            kind: 'passthrough',
            lines: ['upstream version']
          }
        ]
      },
      atTag: { 'src/captured/file.ts': 'upstream version\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(0)
  })

  // a non-ASCII path round-trips through git as latin1 (see gitPathList); classifyPath must
  // compare against the same byte representation or this escapes silent-capture unnoticed
  it('flags a non-ASCII feature-glob path that also exists upstream', () => {
    const { root, base } = buildFixture({
      manifest: {
        features: [{ name: 'captured-feature', purpose: 'x', globs: ['src/café/**'] }]
      },
      atTag: { 'src/café/file.ts': 'upstream version\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[silent-capture]')
    expect(result.stdout).toContain('src/café/file.ts')
  })
})

describe('seam integrity rule', () => {
  it('flags a missing seam line', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          {
            path: 'src/seam-file.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const MARKER = true']
          }
        ]
      },
      atTag: { 'src/seam-file.ts': 'const OTHER = 1\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[seam-integrity]')
    expect(result.stdout).toContain('missing seam line')
  })

  it('allows a seam whose declared line is present verbatim', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          {
            path: 'src/seam-file.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const MARKER = true']
          }
        ]
      },
      atTag: { 'src/seam-file.ts': 'const MARKER = true\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(0)
  })

  it('does not accept a seam line that only appears as a substring of a longer line', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          {
            path: 'src/seam-file.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const MARKER = true']
          }
        ]
      },
      atTag: { 'src/seam-file.ts': '// const MARKER = true (disabled)\n' }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[seam-integrity]')
  })

  it('does not leak git stderr for a missing seam file outside the findings fence', () => {
    const { root, base } = buildFixture({
      manifest: {
        seams: [
          { path: 'src/missing-seam.ts', feature: 'fork-infra', kind: 'passthrough', lines: ['x'] }
        ]
      }
    })

    const result = runGuard(root, base, base)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('[seam-integrity]')
    expect(result.stdout).toContain('cannot read file at HEAD')
    expect(result.stderr).not.toContain('fatal')
    expect(result.stderr).not.toContain('missing-seam')
  })
})

describe('infrastructure error exit code', () => {
  it('exits 2, not gits raw status, when base-sha does not resolve', () => {
    const { root, base } = buildFixture({})
    const badBase = '0'.repeat(40)

    const result = runGuard(root, badBase, base)

    expect(result.status).toBe(2)
  })
})

describe('usage', () => {
  it('exits 2 with usage when the two shas are not both supplied', () => {
    const { root, base } = buildFixture({})

    const result = spawnSync(process.execPath, [guardScript, base], { cwd: root, encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('<base-sha> <head-sha>')
  })
})

describe('workflow registration', () => {
  it('is wired into the PR verify gate', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const guardJob = workflow.jobs.fork_ownership_guard
    const guardStep = guardJob.steps.find((step) => step.name === 'Enforce fork ownership manifest')

    expect(guardJob.steps[0].with['fetch-depth']).toBe(0)
    expect(guardStep.run).toContain('node .github/scripts/check-fork-ownership.mjs')
    expect(workflow.jobs.verify.needs).toContain('fork_ownership_guard')
  })
})
