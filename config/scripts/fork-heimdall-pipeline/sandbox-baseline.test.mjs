import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendSandboxBaseline, SANDBOX_BASELINE_REF } from './sandbox-baseline.mjs'

const directories = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-baseline-test-'))
  directories.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, ['init', '--quiet'])
  git(source, ['config', 'user.name', 'sandbox test'])
  git(source, ['config', 'user.email', 'sandbox-test@example.invalid'])
  git(source, ['config', 'credential.helper', 'source-config-secret-sentinel'])

  writeFileSync(join(source, 'baseline.txt'), 'first commit\n')
  git(source, ['add', 'baseline.txt'])
  git(source, ['commit', '--quiet', '-m', 'first baseline commit'])
  writeFileSync(join(source, 'baseline.txt'), 'selected baseline\n')
  git(source, ['commit', '--quiet', '-am', 'selected baseline commit'])
  git(source, ['tag', 'pipeline-baseline'])
  writeFileSync(join(source, 'current-only.txt'), 'not in baseline\n')
  git(source, ['add', 'current-only.txt'])
  git(source, ['commit', '--quiet', '-m', 'later current commit'])
  git(source, ['tag', 'unrequested-tag'])
  git(source, ['branch', 'unrequested-branch'])

  const sourceTarPath = join(root, 'source.tar')
  writeFileSync(join(root, 'current-tree.txt'), 'current snapshot\n')
  execFileSync('tar', ['-c', '--format=ustar', '-f', sourceTarPath, '-C', root, 'current-tree.txt'])
  return { root, source, sourceTarPath }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('sandbox baseline payload', () => {
  it('transfers only the requested shallow ref and keeps source Git config out of the archive', () => {
    const { root, source, sourceTarPath } = createFixture()
    const expectedCommit = git(source, ['rev-parse', 'refs/tags/pipeline-baseline^{commit}'])

    expect(appendSandboxBaseline(sourceTarPath, 'pipeline-baseline', source)).toEqual({
      sourceRef: 'refs/tags/pipeline-baseline',
      commit: expectedCommit
    })

    const payload = join(root, '.orca-sandbox', 'baseline.git')
    execFileSync('tar', ['-x', '-f', sourceTarPath, '-C', root])
    const refs = git(root, [`--git-dir=${payload}`, 'for-each-ref', '--format=%(refname)']).split(
      '\n'
    )
    expect(refs).toEqual([SANDBOX_BASELINE_REF])
    expect(
      git(root, [`--git-dir=${payload}`, 'rev-parse', `${SANDBOX_BASELINE_REF}^{commit}`])
    ).toBe(expectedCommit)
    expect(git(root, [`--git-dir=${payload}`, 'rev-parse', '--is-shallow-repository'])).toBe('true')

    const archive = readFileSync(sourceTarPath).toString('latin1')
    expect(archive).not.toContain('source-config-secret-sentinel')
    const members = execFileSync('tar', ['-tf', sourceTarPath], { encoding: 'utf8' }).split('\n')
    expect(members.some((member) => member === '.git/config' || member.startsWith('.git/'))).toBe(
      false
    )

    const receiver = join(root, 'receiver')
    mkdirSync(receiver)
    git(receiver, ['init', '--quiet'])
    git(receiver, [
      'fetch',
      '--update-shallow',
      '--depth=1',
      payload,
      `${SANDBOX_BASELINE_REF}:${SANDBOX_BASELINE_REF}`
    ])
    expect(git(receiver, ['rev-parse', `${SANDBOX_BASELINE_REF}^{commit}`])).toBe(expectedCommit)
    expect(git(receiver, ['rev-parse', '--is-shallow-repository'])).toBe('true')
  })

  it('fails on a missing local ref without adding a baseline payload', () => {
    const { source, sourceTarPath } = createFixture()

    expect(() => appendSandboxBaseline(sourceTarPath, 'missing-baseline', source)).toThrow(
      'baseline ref "missing-baseline" does not exist locally'
    )
    expect(execFileSync('tar', ['-tf', sourceTarPath], { encoding: 'utf8' })).toBe(
      'current-tree.txt\n'
    )
  })
})
