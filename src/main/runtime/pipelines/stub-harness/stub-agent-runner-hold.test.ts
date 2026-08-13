import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveStubAgentRunnerPath } from './stub-agent-launcher'
import { createStubHarnessControlDir } from './stub-harness-control-dir'
import { isStubHolding, releaseStubHold, waitForStubHold } from './stub-harness-hold-signal'
import { readStubOutcomeIfPresent, waitForStubOutcome } from './stub-harness-outcome'
import { writeStubInvocationScript } from './stub-harness-script'

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
}

const runnerPath = resolveStubAgentRunnerPath()

// Why the exit promise is built at spawn time, not awaited-for later: a released stub can
// exit within milliseconds, and `once('exit', ...)` attached after the fact can lose the
// event entirely — Node never replays it to a listener added post-hoc.
function spawnStub(
  cwd: string,
  controlDir: string,
  prompt: string
): { child: ChildProcess; exitCode: Promise<number | null> } {
  const child = spawn('node', [runnerPath, controlDir, prompt], { cwd })
  const exitCode = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })
  return { child, exitCode }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('stub-agent-runner.cjs hold/release', () => {
  let root: string
  let repo: string
  let controlDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-stub-agent-hold-'))
    repo = join(root, 'repo')
    initRepo(repo)
    controlDir = createStubHarnessControlDir(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // A test that only "signals then observes" would pass whether or not the hold does
  // anything — this asserts, on live process state and disk state, that the runner has
  // genuinely stopped short of reporting an outcome, before it is ever told to continue.
  it('genuinely blocks before the hold is released, and completes only after', async () => {
    writeStubInvocationScript(controlDir, 0, {
      files: [{ path: 'progress.txt', content: 'made it to the hold\n' }],
      holdAt: 'pre-report',
      outcome: 'success'
    })

    const { exitCode } = spawnStub(repo, controlDir, 'a long-running node')

    await waitForStubHold(controlDir, 0, 'pre-report', 5000)

    // still genuinely held: no outcome yet, and it stays that way across a real wait —
    // not just an instant after reaching the boundary
    expect(readStubOutcomeIfPresent(controlDir, 0)).toBeUndefined()
    await sleep(300)
    expect(readStubOutcomeIfPresent(controlDir, 0)).toBeUndefined()
    expect(isStubHolding(controlDir, 0, 'pre-report')).toBe(true)

    releaseStubHold(controlDir, 0, 'pre-report')

    const outcome = await waitForStubOutcome(controlDir, 0, 5000)

    expect(outcome).toEqual({ index: 0, outcome: 'success', message: null })
    expect(await exitCode).toBe(0)
  })

  it('never reports a hold boundary the script did not ask for', async () => {
    writeStubInvocationScript(controlDir, 0, { outcome: 'success' })

    const { exitCode } = spawnStub(repo, controlDir, 'no hold configured')
    await exitCode

    expect(isStubHolding(controlDir, 0, 'pre-report')).toBe(false)
  })
})
