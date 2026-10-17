import { describe, expect, it, vi } from 'vitest'
import type { CheckOutcome, LoopConfig } from '../../shared/fork-loops/loop-types'
import type { StoredLoop } from './loop-database'
import type { IterationContext, LoopEvidenceTools } from './loop-driver-types'
import { PROTECTED_PATHS_UNVERIFIED, gatherIterationEvidence } from './loop-iteration-evidence'

const FAILED_CHECK: CheckOutcome = {
  ran: true,
  pass: false,
  exitCode: 1,
  timedOut: false,
  stdoutTail: 'fail',
  stderrTail: '',
  durationMs: 1
}

function configWith(done: LoopConfig['done']): LoopConfig {
  return {
    promptSource: { kind: 'repeat', body: 'x' },
    pacing: { kind: 'on-idle' },
    sessionPolicy: 'fresh',
    done,
    caps: {},
    noProgress: false,
    checkpointCommits: false,
    askBeforeNext: false,
    resumeAtLimitReset: false
  }
}

function contextWith(config: LoopConfig, kind: 'git' | 'folder' = 'folder'): IterationContext {
  const loop: StoredLoop = {
    id: 'loop-1',
    worktreeId: 'wt-1',
    workspaceKind: kind,
    executionHostId: 'local',
    name: 'loop',
    slug: 'loop',
    agent: 'claude',
    launchOverrides: null,
    preset: 'until-done',
    config,
    state: 'running',
    pauseReason: null,
    pauseDetail: null,
    tabId: null,
    paneKey: null,
    ptyId: null,
    detached: false,
    iterationsCompleted: 0,
    activeMs: 0,
    costUsd: null,
    skippedTicks: 0,
    nextIterationAt: null,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null
  }
  return {
    n: 1,
    attempt: 0,
    startedAt: 0,
    loop,
    targets: {
      executionHostId: 'local',
      check: { type: 'local', cwd: '/work' },
      workspace: {
        kind,
        workspacePath: '/work',
        pathFlavor: 'posix',
        fs: {
          readFile: async () => ({ content: '', isBinary: false }),
          writeFile: async () => undefined,
          createDir: async () => undefined,
          deletePath: async () => undefined,
          stat: async () => {
            throw new Error('absent')
          }
        },
        runGit: kind === 'git' ? async () => ({ stdout: '', stderr: '' }) : null
      }
    },
    before: null,
    usageBefore: null,
    error: null
  }
}

function toolsWith(check: CheckOutcome): LoopEvidenceTools & {
  evaluate: ReturnType<typeof vi.fn>
} {
  return {
    snapshotTree: async () => null,
    diffTrees: async () => ({ added: 0, removed: 0, files: [] }),
    runCheck: async () => check,
    evaluate: vi.fn(async () => ({ verdict: 'not-met' as const, reason: 'not yet' })),
    readUsage: async () => null,
    readUsageLimit: () => null
  }
}

async function gather(
  config: LoopConfig,
  tools: LoopEvidenceTools,
  kind: 'git' | 'folder' = 'folder'
) {
  return gatherIterationEvidence({
    ctx: contextWith(config, kind),
    tools,
    runtime: {},
    paneHandle: undefined,
    settlement: { kind: 'settled', settledAt: 1 },
    onPhase: () => undefined
  })
}

describe('gatherIterationEvidence done signals', () => {
  const done: LoopConfig['done'] = {
    check: { command: 'false', timeoutSeconds: 1, runWhen: 'every-iteration' },
    evaluator: { condition: 'quality is high' }
  }

  it('records the evaluator verdict even when the check fails', async () => {
    const tools = toolsWith(FAILED_CHECK)
    const evidence = await gather(configWith(done), tools)
    expect(evidence.check?.pass).toBe(false)
    expect(tools.evaluate).toHaveBeenCalledTimes(1)
    expect(evidence.evaluator).toEqual({ verdict: 'not-met', reason: 'not yet' })
  })

  it('records the evaluator verdict when the check is skipped for want of a done claim', async () => {
    const tools = toolsWith(FAILED_CHECK)
    const config = configWith({
      check: { command: 'false', timeoutSeconds: 1, runWhen: 'on-claim' },
      evaluator: done.evaluator
    })
    const evidence = await gather(config, tools)
    expect(evidence.check).toBeNull()
    expect(tools.evaluate).toHaveBeenCalledTimes(1)
  })
})

describe('gatherIterationEvidence protected paths', () => {
  const PASSED_CHECK: CheckOutcome = { ...FAILED_CHECK, pass: true, exitCode: 0 }

  it('reports protected paths as unverified when a git snapshot is unavailable', async () => {
    const config = { ...configWith({}), protectedPaths: ['src/**'] }
    const evidence = await gather(config, toolsWith(PASSED_CHECK), 'git')
    expect(evidence.protectedPathHits).toEqual([PROTECTED_PATHS_UNVERIFIED])
  })

  it('reports no hits for a git loop without protected paths when a snapshot is unavailable', async () => {
    const evidence = await gather(configWith({}), toolsWith(PASSED_CHECK), 'git')
    expect(evidence.protectedPathHits).toEqual([])
  })
})
