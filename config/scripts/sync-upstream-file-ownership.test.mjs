import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const scriptPath = join(projectDir, 'config/scripts/sync-upstream-file-ownership.mjs')
const tempDirs = []

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orca-sync-ownership-'))
  tempDirs.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'sync-ownership-test@example.com'])
  git(root, ['config', 'user.name', 'Sync Ownership Test'])
  return root
}

function writeFiles(root, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

function commitAll(root, message) {
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

function writeManifest(root, manifest) {
  writeFiles(root, { 'config/fork-ownership.json': JSON.stringify(manifest, null, 2) })
}

function baseManifest(overrides = {}) {
  return { features: [], seams: [], exceptions: [], ...overrides }
}

function runScript(root, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd: root, encoding: 'utf8' })
}

function outLines(outDir, name) {
  return readFileSync(join(outDir, name), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// unlike outLines, preserves leading/trailing whitespace in each path
function outLinesExact(outDir, name) {
  return readFileSync(join(outDir, name), 'utf8').split('\n').filter(Boolean)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('classify mode', () => {
  it('sorts each differing path into the list its class requires', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    // manifest content stays identical across both commits so it never itself
    // shows up in the differing-paths diff the classifier is being tested against
    writeManifest(
      root,
      baseManifest({
        features: [{ name: 'fork-x', purpose: 'x', globs: ['tests/feature-owned/**'] }],
        seams: [
          {
            path: 'src/seam-owned.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ],
        exceptions: [{ path: 'docs/ours.md', reason: 'fork policy doc', status: 'permanent' }]
      })
    )
    writeFiles(root, {
      'src/upstream-changed.ts': 'merge-head version\n',
      'src/upstream-removed.ts': 'merge-head version\n'
    })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, {
      'docs/ours.md': 'upstream content\n',
      'src/seam-owned.ts': 'const SEAM_MARKER = true\nupstream addition\n',
      'tests/feature-owned/case.spec.ts': 'upstream version\n',
      'src/upstream-changed.ts': 'target version\n'
    })
    // upstream dropped this file in the target tag
    rmSync(join(root, 'src/upstream-removed.ts'))
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'checkout.txt')).toEqual(['src/upstream-changed.ts'])
    expect(outLines(outDir, 'remove.txt')).toEqual(['src/upstream-removed.ts'])
    expect(outLines(outDir, 'ours.txt')).toEqual(['docs/ours.md'])
    expect(outLines(outDir, 'merge-review.txt').sort()).toEqual(
      ['src/seam-owned.ts', 'tests/feature-owned/case.spec.ts'].sort()
    )
  })

  it('routes a deleted exception to remove.txt even when the path exists at the target', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        exceptions: [
          {
            path: 'src/fork-only.ts',
            reason: 'fork removed this upstream file',
            status: 'permanent',
            deleted: true
          }
        ]
      })
    )
    writeFiles(root, { 'src/fork-only.ts': 'fork content\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'src/fork-only.ts': 'upstream still ships this\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'remove.txt')).toEqual(['src/fork-only.ts'])
    expect(outLines(outDir, 'ours.txt')).toEqual([])
    expect(outLines(outDir, 'checkout.txt')).toEqual([])
  })

  it('prefers an exception over a matching feature glob at the same path', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        features: [{ name: 'fork-x', purpose: 'x', globs: ['src/overlap.ts'] }],
        exceptions: [
          { path: 'src/overlap.ts', reason: 'fork owns this outright', status: 'permanent' }
        ]
      })
    )
    writeFiles(root, { 'src/overlap.ts': 'merge-head version\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'src/overlap.ts': 'target version\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'ours.txt')).toEqual(['src/overlap.ts'])
    expect(outLines(outDir, 'merge-review.txt')).toEqual([])
  })

  it('does not write coupled-tests.txt', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(root, baseManifest())
    writeFiles(root, { 'src/a.ts': 'merge-head\n' })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(existsSync(join(outDir, 'coupled-tests.txt'))).toBe(false)
  })

  it('exits 2 with a usage message when invoked with no arguments', () => {
    const root = initRepo()
    writeFiles(root, { 'README.md': 'base\n' })
    commitAll(root, 'base')

    const result = runScript(root, [])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage')
  })

  it('exits 2 when the manifest is missing', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeFiles(root, { 'src/a.ts': 'merge-head\n' })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('exits 2 when the manifest is invalid', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeFiles(root, {
      'config/fork-ownership.json': '{"features": [], "seams": []}',
      'src/a.ts': 'merge-head\n'
    })
    const mergeHead = commitAll(root, 'merge-head')
    writeFiles(root, { 'src/a.ts': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('classifies a path with leading whitespace by its exact name, not a trimmed one', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        exceptions: [{ path: ' lead.txt', reason: 'fork policy doc', status: 'permanent' }]
      })
    )
    writeFiles(root, { ' lead.txt': 'merge-head version\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { ' lead.txt': 'target version\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLinesExact(outDir, 'ours.txt')).toEqual([' lead.txt'])
  })

  it("classifies a pathname with a quote character without git's C-style quoting mangling it", () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(
      root,
      baseManifest({
        exceptions: [{ path: 'has"quote.txt', reason: 'fork policy doc', status: 'permanent' }]
      })
    )
    writeFiles(root, { 'has"quote.txt': 'merge-head version\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'has"quote.txt': 'target version\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(0)
    expect(outLines(outDir, 'ours.txt')).toEqual(['has"quote.txt'])
  })

  it('exits 2 and names the path when a differing path contains a newline', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)

    writeManifest(root, baseManifest())
    writeFiles(root, { 'README.md': 'base\n' })
    const mergeHead = commitAll(root, 'merge-head')

    writeFiles(root, { 'src/weird\nname.txt': 'target\n' })
    const target = commitAll(root, 'target')

    const result = runScript(root, [target, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('weird')
  })

  it('exits 2 when there are no differing paths to classify', () => {
    const root = initRepo()
    const outDir = join(root, 'out')
    mkdirSync(outDir)
    writeManifest(root, baseManifest())
    writeFiles(root, { 'src/a.ts': 'same\n' })
    const mergeHead = commitAll(root, 'only-commit')

    const result = runScript(root, [mergeHead, mergeHead, outDir])

    expect(result.status).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})

describe('--verify-seams mode', () => {
  it('exits 0 against the working tree when every declared seam line is present', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(0)
  })

  it('exits 1 and names the missing line when a seam line is absent from the working tree', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')
    // corrupt the working tree copy without committing, to prove the default
    // (no ref argument) mode reads the working tree and not a git ref
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/seam.ts')
  })

  it('reads from a git ref rather than a dirty working tree when a ref is given', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    const head = commitAll(root, 'base')
    // dirty the working tree after the commit; a ref-based check must ignore this
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams', head])

    expect(result.status).toBe(0)
  })

  it('reads from a worktree path argument that is not a valid git ref', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')

    const worktreePath = join(root, '..', `${dirname(root).split('/').pop()}-wt`)
    git(root, ['worktree', 'add', '--quiet', worktreePath, 'HEAD'])
    tempDirs.push(worktreePath)

    // dirty the primary working tree; the worktree-path argument must read its own disk copy
    writeFiles(root, { 'src/seam.ts': 'someone dropped the marker\n' })

    const result = runScript(root, ['--verify-seams', worktreePath])

    expect(result.status).toBe(0)
  })

  it('exits 2 when the manifest is missing', () => {
    const root = initRepo()
    writeFiles(root, { 'README.md': 'base\n' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(2)
  })

  it('exits 2 when the manifest is invalid', () => {
    const root = initRepo()
    writeFiles(root, { 'config/fork-ownership.json': 'not json' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(2)
  })

  it('exits 1 when a declared seam line exists only as a substring of another line', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\n' })
    commitAll(root, 'base')
    // the declared line is still a substring here; a substring check would wrongly pass this
    writeFiles(root, { 'src/seam.ts': '// const SEAM_MARKER = true\n' })

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('src/seam.ts')
  })

  it('exits 0 when the declared seam line is present with CRLF line endings', () => {
    const root = initRepo()
    writeManifest(
      root,
      baseManifest({
        seams: [
          {
            path: 'src/seam.ts',
            feature: 'fork-infra',
            kind: 'passthrough',
            lines: ['const SEAM_MARKER = true']
          }
        ]
      })
    )
    writeFiles(root, { 'src/seam.ts': 'const SEAM_MARKER = true\r\nother line\r\n' })
    commitAll(root, 'base')

    const result = runScript(root, ['--verify-seams'])

    expect(result.status).toBe(0)
  })
})

describe('SKILL.md delegates rather than duplicating the ownership recipe', () => {
  const skillText = readFileSync(join(projectDir, '.claude/skills/sync-upstream/SKILL.md'), 'utf8')
  const referenceText = readFileSync(
    join(projectDir, '.claude/skills/sync-upstream/references/file-ownership.md'),
    'utf8'
  )

  it('sends the reader to the reference for the ownership step', () => {
    expect(skillText).toContain('references/file-ownership.md')
  })

  // a second copy of the classifier commands is what silently went stale before; the reference owns them
  it('keeps the classifier invocation out of the runbook', () => {
    expect(skillText).not.toMatch(/xargs -0 git/)
    expect(referenceText).toMatch(/xargs -0 git/)
  })

  it('names no script the repo does not ship', () => {
    for (const text of [skillText, referenceText]) {
      for (const script of text.match(/config\/scripts\/[\w.-]+\.mjs/g) ?? []) {
        expect(existsSync(join(projectDir, script))).toBe(true)
      }
    }
  })

  it('delegates releasing to the release skill', () => {
    expect(skillText).toContain('Skill(release')
  })
})

describe('file-ownership reference procedure', () => {
  const referenceText = readFileSync(
    join(projectDir, '.claude/skills/sync-upstream/references/file-ownership.md'),
    'utf8'
  )

  it('restores ours.txt from the pre-merge fork commit, not from HEAD', () => {
    const oursLine = referenceText.split('\n').find((line) => line.includes('ours.txt'))
    expect(oursLine).toContain('merge_head')
    expect(oursLine).not.toMatch(/git checkout HEAD --/)
  })

  it('passes -- before remove.txt paths so a leading-dash path is not parsed as an option', () => {
    const removeLine = referenceText.split('\n').find((line) => line.includes('remove.txt'))
    expect(removeLine).toMatch(/git rm -f --ignore-unmatch --\s*$/)
  })
})

describe('phase-5 file-ownership reference procedure', () => {
  const referenceText = readFileSync(
    join(projectDir, '.claude/skills/sync-upstream/references/file-ownership.md'),
    'utf8'
  )
  const tierTwoProcedure = referenceText.slice(
    referenceText.indexOf('## Tier-2 forked-copy replay'),
    referenceText.indexOf('## Tier-4 pending-upstream review')
  )
  const tierFourProcedure = referenceText.slice(
    referenceText.indexOf('## Tier-4 pending-upstream review'),
    referenceText.indexOf('## Upstream feature-collision review')
  )
  const collisionProcedure = referenceText.slice(
    referenceText.indexOf('## Upstream feature-collision review'),
    referenceText.indexOf('## When upstream')
  )

  it('requires a validated, whole-tree, NUL-delimited fork-copy status snapshot', () => {
    expect(tierTwoProcedure).toContain("git grep -l '^// FORK-COPY-OF:' -- ':(glob)**/fork-*/**'")
    expect(tierTwoProcedure).toContain('first two physical lines must be the two copy headers')
    expect(tierTwoProcedure).toContain("grep -Eq '^[0-9a-f]{40}([0-9a-f]{24})?$'")
    expect(tierTwoProcedure).toContain('git cat-file -e "${recorded_sha}^{commit}"')
    expect(tierTwoProcedure).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'")
    expect(tierTwoProcedure).toContain('git rev-parse --verify "${target_ref}^{commit}"')
    expect(tierTwoProcedure).toContain('git cat-file -e "${target_commit}:${copy_path}"')

    const statusSnapshot =
      tierTwoProcedure.match(/git diff --name-status -z --find-renames[^\n]+/)?.[0] ?? ''
    expect(statusSnapshot).toContain('"$recorded_sha" "$target_commit"')
    expect(statusSnapshot).not.toContain(' -- ')
  })

  it('classifies renamed, modified, and deleted whitespace paths from the documented parser', () => {
    const command = 'node - "$status_file" "$recorded_path" <<\'NODE\''
    const commandStart = tierTwoProcedure.indexOf(command)
    const sourceStart = tierTwoProcedure.indexOf('\n', commandStart) + 1
    const sourceEnd = tierTwoProcedure.indexOf('\n   NODE', sourceStart)
    expect(commandStart).toBeGreaterThan(-1)
    expect(sourceEnd).toBeGreaterThan(sourceStart)
    const parserSource = tierTwoProcedure.slice(sourceStart, sourceEnd).replace(/^   /gm, '')
    const statusFile = join(mkdtempSync(join(tmpdir(), 'orca-copy-status-')), 'status.bin')
    tempDirs.push(dirname(statusFile))
    writeFileSync(
      statusFile,
      ['R100', 'old name.ts', 'new name.ts', 'M', 'tab\tpath.ts', 'D', '--leading.ts', ''].join(
        '\0'
      )
    )

    const classify = (path) => {
      const result = spawnSync(process.execPath, ['-', statusFile, path], {
        encoding: 'utf8',
        input: parserSource
      })
      expect(result.status).toBe(0)
      return result.stdout.trim() ? JSON.parse(result.stdout) : null
    }

    expect(classify('old name.ts')).toEqual({ kind: 'rename', path: 'new name.ts' })
    expect(classify('tab\tpath.ts')).toEqual({ kind: 'status', status: 'M' })
    expect(classify('--leading.ts')).toEqual({ kind: 'status', status: 'D' })
    expect(classify('unchanged.ts')).toBeNull()
  })

  it('requires complete fork-copy replay and synchronized header fields', () => {
    expect(tierTwoProcedure).toContain('A `D` is not an empty delta')
    expect(tierTwoProcedure).toContain('materially smaller than its recorded source')
    expect(tierTwoProcedure).toContain('every recorded and resolved path')
    expect(tierTwoProcedure).toContain('replay that upstream delta into the\n   fork copy by hand')
    expect(tierTwoProcedure).toContain('<every-recorded-path> <every-resolved-path>')
    expect(tierTwoProcedure).toContain('Update both header fields together')
    expect(tierTwoProcedure).toContain('never advance only the SHA or leave an old path behind')
  })

  it('requires pending-upstream exceptions and their ledger targets to be reviewed atomically', () => {
    expect(tierFourProcedure).toContain(
      'every manifest `exceptions[]` entry whose `status` is `pending-upstream`'
    )
    expect(tierFourProcedure).toContain('`ledger`\ntarget in `docs/fork-upstreaming.md`')
    expect(tierFourProcedure).toContain(
      'review upstream\nmovement over the old-to-new stable-tag range'
    )
    expect(tierFourProcedure).toContain('manifest and ledger state\natomic')
  })

  it('records collision outcomes and preserves user decisions', () => {
    expect(collisionProcedure).toContain(
      'upstream release notes and the\nchangelog for the old-to-new stable-tag range'
    )
    expect(collisionProcedure).toContain(
      'exactly one outcome per feature: `none`,\n`possible`, or `confirmed`'
    )
    expect(collisionProcedure).toContain(
      'Raise every `possible` or `confirmed` outcome to the user'
    )
    expect(collisionProcedure).toContain('Never silently delete a fork feature or reconcile it')
    expect(tierTwoProcedure).toContain('raise it to the user as a collision-policy decision')
  })

  it('builds the CLI before tests with controlled global and system Git config', () => {
    const verificationCommand =
      referenceText.match(/empty_git_config=\$\(mktemp\)[\s\S]*?pnpm test/)?.[0] ?? ''
    const variables = [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_KEY_1',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_VALUE_1',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_NOSYSTEM'
    ]

    for (const variable of variables) {
      expect(verificationCommand).toContain(`-u ${variable}`)
    }
    expect(verificationCommand).toContain('pnpm build:cli && env')
    expect(verificationCommand).toContain('GIT_CONFIG_GLOBAL="$empty_git_config"')
    expect(verificationCommand).toContain('GIT_CONFIG_SYSTEM="$empty_git_config"')
    expect(verificationCommand).toContain('GIT_CONFIG_NOSYSTEM=1')
    expect(verificationCommand).toContain('trap \'rm -f "$empty_git_config"\' EXIT')
    expect(verificationCommand).toMatch(/pnpm test$/)

    const home = mkdtempSync(join(tmpdir(), 'orca-git-config-home-'))
    const emptyConfig = join(home, 'empty.gitconfig')
    tempDirs.push(home)
    writeFileSync(join(home, '.gitconfig'), '[review]\n\tglobal = still-present\n')
    writeFileSync(emptyConfig, '')
    const injectedEnv = {
      ...process.env,
      GIT_CONFIG_PARAMETERS: "'review.parameter=still-present'",
      HOME: home,
      USERPROFILE: home
    }
    const readConfig = (key, environment) =>
      spawnSync('git', ['config', '--get', key], { encoding: 'utf8', env: environment })

    expect(readConfig('review.parameter', injectedEnv).stdout.trim()).toBe('still-present')
    expect(readConfig('review.global', injectedEnv).stdout.trim()).toBe('still-present')
    for (const variable of variables) {
      delete injectedEnv[variable]
    }
    Object.assign(injectedEnv, {
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1'
    })
    expect(readConfig('review.parameter', injectedEnv).status).toBe(1)
    expect(readConfig('review.global', injectedEnv).status).toBe(1)
  })
})
