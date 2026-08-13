import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { buildStubAgentCmdOverride } from './stub-agent-launcher'
import { createStubHarnessControlDir } from './stub-harness-control-dir'
import { readStubReceivedArgv, readStubReceivedPrompt } from './stub-harness-received-prompt'
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

// Runs a launch command exactly the way it would reach a real login shell — this is what
// makes the fidelity assertion meaningful: it exercises the production quoting logic
// (buildAgentStartupPlan / quoteStartupArg) and a real OS shell parse, not a JS argv array
// the test assembled by hand.
function runThroughRealShell(command: string, cwd: string) {
  if (process.platform === 'win32') {
    return spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      cwd,
      encoding: 'utf8'
    })
  }
  return spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8' })
}

describe('stub agent launch command fidelity (real production quoting)', () => {
  let root: string
  let repo: string
  let controlDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-stub-launch-fidelity-'))
    repo = join(root, 'repo')
    initRepo(repo)
    controlDir = createStubHarnessControlDir(root)
    writeStubInvocationScript(controlDir, 0, { outcome: 'success' })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // The override + prompt survive real shell quoting (quotes, `$`, backticks, backslash,
  // an embedded newline, unicode) — a hand-built argv array in the test would prove nothing
  // about quoting; only routing the text through the actual launch-command builder and a
  // real shell can.
  it('delivers the exact prompt text through buildAgentStartupPlan and a real shell', () => {
    const trickyPrompt = [
      'Bug report: cost is $100 (see `git log`).',
      `Says "hello" and doesn't forget a backslash \\ here.`,
      'Unicode: 🚀 — done.'
    ].join('\n')

    const override = buildStubAgentCmdOverride(controlDir)
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: trickyPrompt,
      cmdOverrides: { claude: override },
      platform: process.platform
    })
    expect(plan).not.toBeNull()

    const result = runThroughRealShell(plan!.launchCommand, repo)

    expect(result.status).toBe(0)
    expect(readStubReceivedPrompt(controlDir, 0)).toBe(trickyPrompt)
  })

  // The real launch path can insert session-option/CLI-arg tokens between the override
  // command and the prompt (buildAgentStartupPlan appends the prompt last, unconditionally —
  // see resolveAgentLaunchCommand). The runner must still find its control dir and the
  // prompt correctly when that happens.
  it('still locates the control dir and the prompt when extra launch tokens sit between them', () => {
    const prompt = 'prompt after extra tokens'
    const override = buildStubAgentCmdOverride(controlDir)
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt,
      cmdOverrides: { claude: override },
      platform: process.platform,
      agentArgs: '--extra-flag demo-value',
      sessionOptionsOverrideAgentArgs: true
    })
    expect(plan).not.toBeNull()
    expect(plan!.launchCommand.length).toBeGreaterThan(override.length)

    const result = runThroughRealShell(plan!.launchCommand, repo)

    expect(result.status).toBe(0)
    const argv = readStubReceivedArgv(controlDir, 0)
    expect(argv.length).toBeGreaterThan(2)
    expect(readStubReceivedPrompt(controlDir, 0)).toBe(prompt)
  })
})
