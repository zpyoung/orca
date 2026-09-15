import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../../..')
const workflow = parse(readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8'))
const versionStep = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.id === 'version' && step.name === 'Compute next version')

function runVersion({ state = 'true', stale = false, deleted = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'orca-rc-recovery-'))
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    mkdirSync(join(cwd, 'config/scripts'), { recursive: true })
    mkdirSync(join(cwd, 'bin'))
    copyFileSync(
      join(projectDir, 'config/scripts/release-rc-history.mjs'),
      join(cwd, 'config/scripts/release-rc-history.mjs')
    )
    writeFileSync(
      join(cwd, 'config/scripts/latest-stable-release.mjs'),
      "console.log('v1.4.202')\n"
    )
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '1.4.202' }))
    writeFileSync(
      join(cwd, 'bin/gh'),
      '#!/bin/bash\nif [[ "$RELEASE_STATE" == missing ]]; then exit 1; fi\nprintf "%s\\n" "$RELEASE_STATE"\n',
      { mode: 0o755 }
    )
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test Bot')
    git('config', 'user.email', 'test@example.com')
    git('commit', '--allow-empty', '-m', 'initial')
    git('commit', '--allow-empty', '-m', 'release: v1.4.203-rc.0.zy09')
    // decoys sit on the release commit so only tag-name selection can reject them
    git('tag', 'v1.4.203-rc.0')
    git('tag', 'v1.4.203-rc.0.zy01')
    if (!deleted) {
      git('tag', 'v1.4.203-rc.0.zy09')
    }
    if (stale) {
      git('commit', '--allow-empty', '-m', 'new source')
      git('commit', '--allow-empty', '-m', 'later source')
    }
    const output = join(cwd, 'output')
    execFileSync('bash', ['-c', versionStep.run], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(cwd, 'bin')}${delimiter}${process.env.PATH}`,
        KIND: 'rc',
        VERSION_SUFFIX: 'zy10',
        EXPLICIT_VERSION: '',
        RELEASE_STATE: state,
        GITHUB_REPOSITORY: 'zpyoung/orca',
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: cwd
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('release-cut fork RC recovery', () => {
  it.each(['true', 'missing'])(
    'recovers the highest fork suffix when release state is %s',
    (state) => {
      expect(runVersion({ state })).toEqual({
        recovered_tag: 'v1.4.203-rc.0.zy09',
        recovered: 'true'
      })
    }
  )

  it('advances instead of recovering a published fork tag', () => {
    expect(runVersion({ state: 'false' })).toEqual({ version: '1.4.203-rc.1.zy10' })
  })

  it('advances instead of recovering a stale fork tag', () => {
    expect(runVersion({ stale: true })).toEqual({ version: '1.4.203-rc.1.zy10' })
  })

  it('does not recover a lower suffix or upstream tag when the highest fork tag was deleted', () => {
    expect(runVersion({ deleted: true })).toEqual({ version: '1.4.203-rc.1.zy10' })
  })
})
