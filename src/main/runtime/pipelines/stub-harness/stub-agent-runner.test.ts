import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveStubAgentRunnerPath } from './stub-agent-launcher'
import { createStubHarnessControlDir } from './stub-harness-control-dir'
import { readStubOutcomeIfPresent } from './stub-harness-outcome'
import { readStubReceivedPrompt } from './stub-harness-received-prompt'
import { writeStubInvocationScript } from './stub-harness-script'

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// `git init -b` post-dates the Git 2.25 baseline; set the branch name before the first
// commit instead, which every Git version supports.
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
}

const runnerPath = resolveStubAgentRunnerPath()

function runStub(cwd: string, controlDir: string, prompt: string) {
  return spawnSync('node', [runnerPath, controlDir, prompt], { cwd, encoding: 'utf8' })
}

describe('stub-agent-runner.cjs', () => {
  let root: string
  let repo: string
  let controlDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-stub-agent-runner-'))
    repo = join(root, 'repo')
    initRepo(repo)
    writeFileSync(join(repo, 'existing.txt'), 'original\n')
    git(['add', 'existing.txt'], repo)
    git(['commit', '-qm', 'init'], repo)
    controlDir = createStubHarnessControlDir(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes tracked and untracked files, commits, and reports success', () => {
    writeStubInvocationScript(controlDir, 0, {
      files: [
        { path: 'untracked.txt', content: 'scratch\n' },
        { path: 'nested/tracked.txt', content: 'committed\n', stage: true }
      ],
      commit: 'stub: scripted commit',
      outcome: 'success'
    })

    const result = runStub(repo, controlDir, 'do the thing')

    expect(result.status).toBe(0)
    expect(readStubOutcomeIfPresent(controlDir, 0)).toEqual({
      index: 0,
      outcome: 'success',
      message: null
    })
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('scratch\n')
    expect(readFileSync(join(repo, 'nested/tracked.txt'), 'utf8')).toBe('committed\n')

    const status = git(['status', '--porcelain', '--untracked-files=all'], repo)
    expect(status).toContain('?? untracked.txt')
    expect(status).not.toContain('nested/tracked.txt')

    const log = git(['log', '--format=%s'], repo)
    expect(log).toContain('stub: scripted commit')
  })

  // The harness is only useful if a script that says "fail" genuinely fails — a stub that
  // always reports success (or exits 0 with a "failed" flag buried in a file nobody checks
  // for exit status) would silently defeat every retry/exhaustion acceptance criterion.
  it('reports a scripted failure as a genuine failure: exit code AND outcome record', () => {
    writeStubInvocationScript(controlDir, 0, {
      files: [{ path: 'junk.txt', content: 'oops\n' }],
      outcome: 'failure',
      failureMessage: 'scripted to fail'
    })

    const result = runStub(repo, controlDir, 'do the thing badly')

    expect(result.status).toBe(1)
    expect(readStubOutcomeIfPresent(controlDir, 0)).toEqual({
      index: 0,
      outcome: 'failure',
      message: 'scripted to fail'
    })
    expect(existsSync(join(repo, 'junk.txt'))).toBe(true)
    // no commit was scripted, so history must be unchanged
    expect(git(['log', '--format=%s'], repo).trim()).toBe('init')
  })

  it('claims sequential indices across repeated invocations, in call order', () => {
    writeStubInvocationScript(controlDir, 0, { outcome: 'success' })
    writeStubInvocationScript(controlDir, 1, { outcome: 'failure', failureMessage: 'second' })

    const first = runStub(repo, controlDir, 'prompt for first attempt')
    const second = runStub(repo, controlDir, 'prompt for second attempt')

    expect(first.status).toBe(0)
    expect(second.status).toBe(1)
    expect(readStubReceivedPrompt(controlDir, 0)).toBe('prompt for first attempt')
    expect(readStubReceivedPrompt(controlDir, 1)).toBe('prompt for second attempt')
  })

  it('records the exact prompt text it received, verbatim', () => {
    writeStubInvocationScript(controlDir, 0, { outcome: 'success' })
    const distinguishing = `bug report ${Math.random().toString(36).slice(2)}\nsecond line`

    runStub(repo, controlDir, distinguishing)

    expect(readStubReceivedPrompt(controlDir, 0)).toBe(distinguishing)
  })

  it('distinguishes a runner-internal error (no script provided) from a scripted failure', () => {
    const result = runStub(repo, controlDir, 'no script exists for this index')

    expect(result.status).toBe(3)
    expect(readStubOutcomeIfPresent(controlDir, 0)).toBeUndefined()
    expect(existsSync(join(controlDir, '0.error.json'))).toBe(true)
  })
})
