import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CheckOutcome,
  EvaluatorVerdict,
  LoopConfig,
  NeedsYouReason
} from '../../shared/fork-loops/loop-types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import { LoopDatabase, type LoopInsert, type StoredLoop } from './loop-database'
import {
  LoopDriver,
  type LoopDriverDeps,
  type LoopDriverRuntime,
  type LoopEvidenceTools
} from './loop-driver'
import type { IterationSettlement, ObserveIterationArgs } from './iteration-observer'
import type { LoopEvaluationArgs } from './loop-evaluator'
import { buildLoopNotification } from './loop-notify'
import { LoopStore } from './loop-store'

const BASE_CONFIG: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'fix the failing tests' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: { check: { command: 'pnpm test', timeoutSeconds: 60, runWhen: 'every-iteration' } },
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

const PASS: CheckOutcome = {
  ran: true,
  pass: true,
  exitCode: 0,
  timedOut: false,
  stdoutTail: 'ok',
  stderrTail: '',
  durationMs: 5
}

const FAIL: CheckOutcome = {
  ran: true,
  pass: false,
  exitCode: 1,
  timedOut: false,
  stdoutTail: 'expected 2 got 3',
  stderrTail: '',
  durationMs: 5
}

type Step =
  | IterationSettlement
  | ((args: ObserveIterationArgs) => Promise<IterationSettlement> | IterationSettlement)

type Harness = ReturnType<typeof createHarness>

const databases: LoopDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function createHarness(options: {
  config?: Partial<LoopConfig>
  loop?: Partial<LoopInsert>
  checks?: CheckOutcome[]
  diffFiles?: string[]
  commit?: 'ok' | 'fail'
  queue?: string[]
}) {
  const database = new LoopDatabase(':memory:')
  databases.push(database)
  const state = { clock: 1_000_000, launches: 0 }
  const store = new LoopStore(database, () => state.clock)
  const config = { ...BASE_CONFIG, ...options.config }
  store.insertLoop({
    id: 'loop-1',
    worktreeId: 'wt-1',
    workspaceKind: 'git',
    executionHostId: 'local',
    name: 'Fix tests',
    slug: 'fix-tests-1',
    agent: 'claude',
    preset: 'until-done',
    config,
    state: 'running',
    tabId: 'tab-0',
    paneKey: 'tab-0:leaf-0',
    ptyId: 'pty-0',
    ...options.loop
  })
  for (const body of options.queue ?? []) {
    store.applyQueueOp('loop-1', { op: 'add', body })
  }

  const panes = new Map<string, { handle: string; ptyId: string }>([
    ['tab-0:leaf-0', { handle: 'term-0', ptyId: 'pty-0' }]
  ])
  const prompts: { handle: string; prompt: string }[] = []
  const gitCalls: string[][] = []
  const liveness: PtyLivenessVerdict[] = []
  const steps: Step[] = []
  const checks = [...(options.checks ?? [])]
  let tree = 0

  const launchPane = async (): Promise<RuntimeTerminalCreate> => {
    state.launches += 1
    const id = state.launches
    panes.set(`tab-${id}:leaf-${id}`, { handle: `term-${id}`, ptyId: `pty-${id}` })
    return {
      handle: `term-${id}`,
      tabId: `tab-${id}`,
      paneKey: `tab-${id}:leaf-${id}`,
      ptyId: `pty-${id}`,
      worktreeId: 'wt-1',
      title: 'Fix tests'
    }
  }

  const runtime = {
    launchAgentTerminal: vi.fn(launchPane),
    createTerminal: vi.fn(
      (_selector: string, _options: { startupAgent: string; rendererBacked?: boolean }) =>
        launchPane()
    ),
    closeTerminalTab: vi.fn(async (handle: string) => {
      for (const [key, pane] of panes) {
        if (pane.handle === handle) {
          panes.delete(key)
        }
      }
      return { handle, tabId: 'tab', closeMode: 'tab' as const, ptyKilled: true }
    }),
    sendTerminalAgentPrompt: vi.fn(
      async (
        handle: string,
        prompt: string,
        sendOptions: { beforeWrite?: (ptyId: string) => void | Promise<void> }
      ) => {
        prompts.push({ handle, prompt })
        await sendOptions.beforeWrite?.('pty')
        return {}
      }
    ),
    getTerminalHandleForPaneKey: (paneKey: string) => panes.get(paneKey)?.handle ?? null,
    getTerminalPtyIdForHandle: (handle: string) =>
      [...panes.values()].find((pane) => pane.handle === handle)?.ptyId ?? null,
    getPtyLivenessVerdict: vi.fn(
      (ptyId: string): PtyLivenessVerdict => liveness.shift() ?? { status: 'live', ptyIds: [ptyId] }
    ),
    readTerminal: async () => ({ tail: ['agent output'] }),
    waitForTerminal: async (handle: string) => ({
      handle,
      condition: 'tui-idle' as const,
      satisfied: true,
      status: 'running' as const,
      exitCode: null
    })
  } satisfies LoopDriverRuntime

  const tools = {
    snapshotTree: vi.fn(async () => {
      tree += 1
      return { treeId: `tree-${tree}`, headSha: 'head' }
    }),
    diffTrees: vi.fn(async () => ({
      added: 3,
      removed: 1,
      files: options.diffFiles ?? ['src/app.ts']
    })),
    runCheck: vi.fn(
      async (_config: LoopConfig, _target: unknown, _signal?: AbortSignal) => checks.shift() ?? PASS
    ),
    evaluate: vi.fn(async (_args: LoopEvaluationArgs): Promise<EvaluatorVerdict> => ({
      verdict: 'met',
      reason: 'ok'
    })),
    readUsage: vi.fn(async () => null),
    readUsageLimit: vi.fn(() => null)
  } satisfies LoopEvidenceTools

  const observeIteration = vi.fn(
    async (args: ObserveIterationArgs): Promise<IterationSettlement> => {
      state.clock += 1000
      const step = steps.shift() ?? { kind: 'settled' as const, settledAt: state.clock }
      return typeof step === 'function' ? step(args) : step
    }
  )

  const runGit = vi.fn(async (args: string[]) => {
    gitCalls.push(args)
    if (args[0] === 'commit' && options.commit === 'fail') {
      throw new Error('hook rejected the commit')
    }
    return { stdout: args[0] === 'rev-parse' ? 'abc123\n' : '', stderr: '' }
  })

  const changes: string[] = []
  const notifications: { event: string; detail?: string }[] = []
  const typing = { busy: 0 }
  const deps: LoopDriverDeps = {
    store,
    runtime,
    observer: { observeIteration },
    inputAttribution: {
      noteLoopWrite: vi.fn(),
      userIdleFor: () => {
        if (typing.busy > 0) {
          typing.busy -= 1
          return false
        }
        return true
      }
    },
    tools,
    targets: async () => ({
      executionHostId: 'local',
      check: { type: 'local', cwd: '/work' },
      workspace: {
        kind: 'git',
        workspacePath: '/work',
        pathFlavor: 'posix',
        fs: {
          readFile: async () => ({ content: '', isBinary: false }),
          writeFile: async () => undefined,
          createDir: async () => undefined,
          deletePath: async () => undefined,
          stat: async () => {
            throw new Error('missing')
          }
        },
        runGit
      }
    }),
    changed: () => {
      const row = store.getLoop('loop-1')
      const phase = driver.current()?.phase ?? '-'
      changes.push(`${row?.state}|${phase}|${row?.iterationsCompleted}`)
    },
    notify: (_loop, event, detail) => notifications.push({ event, detail }),
    now: () => state.clock,
    sleep: async (ms) => {
      state.clock += ms
    },
    pollMs: 10
  }
  const driver = new LoopDriver('loop-1', deps)
  return {
    driver,
    store,
    state,
    runtime,
    tools,
    observeIteration,
    runGit,
    gitCalls,
    prompts,
    changes,
    notifications,
    steps,
    typing,
    liveness,
    row: (): StoredLoop => {
      const row = store.getLoop('loop-1')
      if (!row) {
        throw new Error('loop missing')
      }
      return row
    },
    run: async () => {
      driver.start()
      await driver.whenIdle()
    }
  }
}

function settled(h: Harness): IterationSettlement {
  return { kind: 'settled', settledAt: h.state.clock }
}

describe('LoopDriver until-done run', () => {
  it('fails two checks, passes the third, and completes with one change per transition', async () => {
    const h = createHarness({ checks: [FAIL, FAIL, PASS] })

    await h.run()

    const row = h.row()
    expect(row.state).toBe('completed')
    expect(row.iterationsCompleted).toBe(3)
    expect(h.store.listIterations('loop-1').map((it) => it.endReason)).toEqual([
      'settled',
      'settled',
      'settled'
    ])
    expect(h.changes.filter((change) => change.startsWith('completed'))).toHaveLength(1)
    h.changes.forEach((change, index) => {
      expect(change).not.toBe(h.changes[index - 1])
    })
  })

  it('carries the failed check output into the next prompt and the preamble into a fresh session', async () => {
    const h = createHarness({ checks: [FAIL, PASS] })

    await h.run()

    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[0]?.prompt).toContain('LOOP_DONE')
    expect(h.prompts[1]?.prompt).toContain('The previous check failed')
    expect(h.prompts[1]?.prompt).toContain('expected 2 got 3')
    expect(h.prompts[1]?.prompt).toContain('LOOP_DONE')
  })

  it('reuses the launched pane for the first iteration and relaunches for the next fresh one', async () => {
    const h = createHarness({ checks: [FAIL, PASS] })

    await h.run()

    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(h.prompts.map((p) => p.handle)).toEqual(['term-0', 'term-1'])
    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-0')
    expect(h.row().paneKey).toBe('tab-1:leaf-1')
  })

  it('keeps one session and sends the preamble once when the policy is continue', async () => {
    const h = createHarness({ config: { sessionPolicy: 'continue' }, checks: [FAIL, PASS] })

    await h.run()

    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(h.prompts[0]?.prompt).toContain('LOOP_DONE')
    expect(h.prompts[1]?.prompt).not.toContain('automated loop')
  })

  it('persists the evidence of each iteration', async () => {
    const h = createHarness({ checks: [PASS] })

    await h.run()

    const [iteration] = h.store.listIterations('loop-1')
    expect(iteration?.check?.pass).toBe(true)
    expect(iteration?.diff).toEqual({ added: 3, removed: 1, files: ['src/app.ts'] })
    expect(iteration?.treeBefore).not.toBeNull()
    expect(iteration?.treeAfter).not.toBeNull()
    expect(iteration?.outputTail).toBe('agent output')
    expect(iteration?.promptSent).toContain('fix the failing tests')
  })
})

describe('LoopDriver holds and stops', () => {
  it('finishes the running iteration and then pauses for a user pause', async () => {
    const h = createHarness({ checks: [FAIL, PASS] })
    h.steps.push(async () => {
      h.driver.requestPause()
      return settled(h)
    })

    await h.run()

    const row = h.row()
    expect(row.state).toBe('paused')
    expect(row.pauseReason).toBe('user')
    expect(row.iterationsCompleted).toBe(1)
    expect(h.prompts).toHaveLength(1)
    expect(h.store.listIterations('loop-1')[0]?.endReason).toBe('settled')
  })

  it('aborts the observer on stop now and ends stopped, never paused', async () => {
    const h = createHarness({})
    let sawAbort = false
    h.steps.push(
      (args) =>
        new Promise((resolve) => {
          args.signal.addEventListener('abort', () => {
            sawAbort = true
            resolve({ kind: 'aborted' })
          })
          h.driver.requestStop('now')
        })
    )

    await h.run()

    const row = h.row()
    expect(sawAbort).toBe(true)
    expect(row.state).toBe('stopped')
    expect(row.pauseReason).toBeNull()
    expect(h.store.listIterations('loop-1')[0]?.endReason).toBe('stopped')
    expect(h.changes.some((change) => change.startsWith('paused'))).toBe(false)
  })

  it('aborts a running check on stop now and ends stopped without counting a pass', async () => {
    const h = createHarness({})
    let checkSignal: AbortSignal | undefined
    h.tools.runCheck.mockImplementationOnce(
      (_config, _target, signal) =>
        new Promise<CheckOutcome>((resolve) => {
          checkSignal = signal
          signal?.addEventListener('abort', () =>
            resolve({ ...FAIL, ran: false, error: 'aborted' })
          )
          h.driver.requestStop('now')
        })
    )

    await h.run()

    const [iteration] = h.store.listIterations('loop-1')
    expect(checkSignal?.aborted).toBe(true)
    expect(iteration?.endReason).toBe('stopped')
    expect(iteration?.check?.pass).toBe(false)
    expect(h.row().state).toBe('stopped')
    expect(h.row().iterationsCompleted).toBe(0)
  })

  it('aborts a running evaluator on stop now', async () => {
    const h = createHarness({ config: { done: { evaluator: { condition: 'good' } } } })
    let evaluatorSignal: AbortSignal | undefined
    h.tools.evaluate.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          evaluatorSignal = args.signal
          args.signal?.addEventListener('abort', () =>
            resolve({ verdict: 'not-met', reason: 'evaluator-aborted' })
          )
          h.driver.requestStop('now')
        })
    )

    await h.run()

    expect(evaluatorSignal?.aborted).toBe(true)
    expect(h.store.listIterations('loop-1')[0]?.endReason).toBe('stopped')
    expect(h.row().state).toBe('stopped')
  })

  it('ends stopped after the iteration for a stop after iteration', async () => {
    const h = createHarness({})
    h.steps.push(async () => {
      h.driver.requestStop('after-iteration')
      return settled(h)
    })

    await h.run()

    expect(h.row().state).toBe('stopped')
    expect(h.row().iterationsCompleted).toBe(1)
    expect(h.prompts).toHaveLength(1)
  })

  it('does not send over the user while they are typing', async () => {
    const h = createHarness({})
    h.typing.busy = 3

    await h.run()

    expect(h.prompts).toHaveLength(1)
    expect(h.state.clock).toBeGreaterThanOrEqual(1_000_000 + 30)
  })

  it('clears the pause when resumed and judges the next iteration afresh', async () => {
    const h = createHarness({ config: { askBeforeNext: true, done: {} } })

    await h.run()
    expect(h.row().pauseReason).toBe('ask-before-next')
    h.store.updateLoop('loop-1', { state: 'running', pauseReason: null })
    h.driver.resume()
    await h.driver.whenIdle()

    expect(h.prompts).toHaveLength(2)
    expect(h.row().pauseReason).toBe('ask-before-next')
  })
})

describe('LoopDriver steer notes and queue', () => {
  it('sends a steer note once', async () => {
    const h = createHarness({ checks: [FAIL, PASS] })
    h.store.addSteerNote('loop-1', 'prefer small diffs')

    await h.run()

    expect(h.prompts[0]?.prompt).toContain('prefer small diffs')
    expect(h.prompts[1]?.prompt).not.toContain('prefer small diffs')
  })

  it('keeps a steer note pending when the prompt write fails so the retry carries it', async () => {
    const h = createHarness({})
    h.store.addSteerNote('loop-1', 'prefer small diffs')
    h.runtime.sendTerminalAgentPrompt.mockRejectedValueOnce(new Error('write failed'))

    await h.run()

    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.prompt).toContain('prefer small diffs')
    expect(h.store.takePendingSteerNotes('loop-1', 99)).toEqual([])
  })

  it('consumes queue items in order and completes when none is left', async () => {
    const h = createHarness({
      config: { promptSource: { kind: 'queue', repeatQueue: false }, done: {} },
      loop: { preset: 'queue' },
      queue: ['first task', 'second task', 'third task']
    })

    await h.run()

    expect(h.prompts.map((p) => /(first|second|third) task/.exec(p.prompt)?.[0])).toEqual([
      'first task',
      'second task',
      'third task'
    ])
    expect(h.row().state).toBe('completed')
    expect(h.store.listQueue('loop-1').every((item) => item.state === 'done')).toBe(true)
  })
})

describe('LoopDriver detached and relaunch', () => {
  it('relaunches a detached loop in the background with a fresh session', async () => {
    const h = createHarness({
      config: { sessionPolicy: 'continue' },
      loop: { detached: true }
    })
    h.runtime.getTerminalHandleForPaneKey = () => null

    await h.run()

    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
    const [selector, options] = h.runtime.createTerminal.mock.calls[0] ?? []
    expect(selector).toBe('id:wt-1')
    expect(options).toMatchObject({ startupAgent: 'claude', title: 'Fix tests' })
    expect(options).not.toHaveProperty('rendererBacked')
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.handle).toBe('term-1')
    expect(h.prompts[0]?.prompt).toContain('LOOP_DONE')
    expect(h.row().detached).toBe(true)
    expect(h.row().paneKey).toBe('tab-1:leaf-1')
  })

  it('binds the new tab and records the close error when the old tab will not close', async () => {
    const h = createHarness({ checks: [FAIL, PASS] })
    h.runtime.closeTerminalTab.mockRejectedValueOnce(new Error('boom'))

    await h.run()

    const [first, second] = h.store.listIterations('loop-1')
    expect(second?.endReason).toBe('settled')
    expect(second?.error).toContain('previous tab did not close: boom')
    expect(first?.error).toBeNull()
    expect(h.row().paneKey).toBe('tab-1:leaf-1')
    expect(h.row().state).toBe('completed')
  })

  it('retries a crashed iteration once in a fresh session and then pauses', async () => {
    const h = createHarness({})
    h.steps.push({ kind: 'crashed', exitCode: 1 }, { kind: 'crashed', exitCode: 1 })

    await h.run()

    const rows = h.store.listIterations('loop-1')
    expect(rows.map((it) => [it.n, it.attempt, it.endReason])).toEqual([
      [1, 0, 'crashed'],
      [1, 1, 'crashed']
    ])
    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(h.row().state).toBe('paused')
    expect(h.row().pauseReason).toBe('crashed')
    expect(h.notifications.map((n) => n.event)).toEqual(['paused'])
  })

  it('treats a failed relaunch as a crash of the iteration', async () => {
    const h = createHarness({ config: { sessionPolicy: 'continue' } })
    h.runtime.getTerminalHandleForPaneKey = () => null
    h.runtime.launchAgentTerminal.mockRejectedValue(new Error('no window'))

    await h.run()

    const rows = h.store.listIterations('loop-1')
    expect(rows.map((it) => it.endReason)).toEqual(['crashed', 'crashed'])
    expect(rows[0]?.error).toBe('no window')
    expect(h.row().pauseReason).toBe('crashed')
    expect(h.prompts).toHaveLength(0)
  })
})

describe('LoopDriver resume after repeated crashes', () => {
  it('keeps both crash records and numbers the resumed attempt after them', async () => {
    const h = createHarness({})
    h.steps.push({ kind: 'crashed', exitCode: 1 }, { kind: 'crashed', exitCode: 1 })

    await h.run()
    expect(h.row().pauseReason).toBe('crashed')
    h.store.updateLoop('loop-1', { state: 'running', pauseReason: null })
    h.driver.resume()
    await h.driver.whenIdle()

    const rows = h.store.listIterations('loop-1')
    expect(rows.map((it) => [it.n, it.attempt, it.endReason])).toEqual([
      [1, 0, 'crashed'],
      [1, 1, 'crashed'],
      [1, 2, 'settled']
    ])
  })
})

describe('LoopDriver unverifiable hosts', () => {
  it('holds a launch that cannot be confirmed instead of spending the crash retry', async () => {
    const h = createHarness({ config: { sessionPolicy: 'continue' } })
    h.runtime.getTerminalHandleForPaneKey = () => null
    let waits = 0
    h.runtime.waitForTerminal = async (handle: string) => {
      waits += 1
      if (waits === 1) {
        throw new Error('ssh connection lost')
      }
      return {
        handle,
        condition: 'tui-idle' as const,
        satisfied: true,
        status: 'running' as const,
        exitCode: null
      }
    }
    h.liveness.push({ status: 'unverifiable', reason: 'ssh down' })

    await h.run()

    const rows = h.store.listIterations('loop-1')
    expect(rows.map((it) => [it.attempt, it.endReason])).toEqual([[0, 'settled']])
    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(h.row().state).toBe('completed')
  })

  it('holds without counting a crash and continues the same iteration when the pty is live', async () => {
    const h = createHarness({})
    h.steps.push({ kind: 'unverifiable' }, { kind: 'unverifiable' })

    await h.run()

    const rows = h.store.listIterations('loop-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.endReason).toBe('settled')
    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(h.observeIteration).toHaveBeenCalledTimes(3)
    expect(h.row().state).toBe('completed')
  })

  it('ends the iteration crashed, taking the single retry, when the pty exited meanwhile', async () => {
    const h = createHarness({})
    h.steps.push({ kind: 'unverifiable' })
    h.liveness.push({ status: 'unverifiable', reason: 'ssh down' }, { status: 'exited' })

    await h.run()

    const rows = h.store.listIterations('loop-1')
    expect(rows.map((it) => [it.attempt, it.endReason])).toEqual([
      [0, 'crashed'],
      [1, 'settled']
    ])
    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('LoopDriver checkpoint commits', () => {
  const checkpointing = { checkpointCommits: true }

  it('stages and commits a changed tree and records the commit', async () => {
    const h = createHarness({ config: checkpointing })

    await h.run()

    expect(h.gitCalls).toEqual([
      ['add', '-A', '--', '.', ':(exclude).orca/loops'],
      ['commit', '-m', 'loop(Fix tests): iteration 1'],
      ['rev-parse', 'HEAD']
    ])
    expect(h.store.listIterations('loop-1')[0]?.checkpointCommit).toBe('abc123')
  })

  it('skips the commit when the iteration touched a protected path', async () => {
    const h = createHarness({
      config: { ...checkpointing, protectedPaths: ['src/**'] },
      checks: [FAIL],
      diffFiles: ['src/app.ts']
    })

    await h.run()

    expect(h.gitCalls.some((call) => call[0] === 'commit')).toBe(false)
    expect(h.store.listIterations('loop-1')[0]?.checkpointCommit).toBeNull()
    expect(h.row().pauseReason).toBe('protected-path')
  })

  it('records the error and keeps going when the commit fails', async () => {
    const h = createHarness({ config: checkpointing, commit: 'fail' })

    await h.run()

    const [iteration] = h.store.listIterations('loop-1')
    expect(iteration?.checkpointCommit).toBeNull()
    expect(iteration?.error).toContain('checkpoint commit failed')
    expect(h.row().state).toBe('completed')
  })

  it('never commits when checkpoint commits are off', async () => {
    const h = createHarness({})

    await h.run()

    expect(h.gitCalls).toEqual([])
  })
})

describe('LoopDriver notifications and active time', () => {
  it('notifies on completion', async () => {
    const h = createHarness({})

    await h.run()

    expect(h.notifications.map((n) => n.event)).toEqual(['completed'])
  })

  it('notifies when the agent needs the user and excludes that time from active time', async () => {
    const h = createHarness({})
    h.steps.push(async (args) => {
      h.state.clock += 10_000
      args.onNeedsYou('permission' satisfies NeedsYouReason)
      expect(h.row().state).toBe('needs-you')
      h.state.clock += 60_000
      args.onResumed()
      h.state.clock += 10_000
      return settled(h)
    })

    await h.run()

    expect(h.notifications.map((n) => n.event)).toEqual(['needs-you', 'completed'])
    expect(h.notifications[0]?.detail).toBe('permission')
    expect(h.row().activeMs).toBe(21_000)
  })

  it('reports a reached iteration cap as cap-reached', async () => {
    const h = createHarness({ config: { caps: { maxIterations: 1 }, done: {} } })

    await h.run()

    expect(h.row().pauseReason).toBe('cap-iterations')
    expect(h.notifications.map((n) => n.event)).toEqual(['cap-reached'])
  })

  it('reports a no-progress pause as paused with its reason', async () => {
    const h = createHarness({ config: { noProgress: true }, checks: [FAIL, FAIL, FAIL] })
    h.tools.snapshotTree.mockImplementation(async () => ({ treeId: 'same', headSha: 'head' }))

    await h.run()

    expect(h.row().pauseReason).toBe('no-progress')
    expect(h.notifications).toEqual([{ event: 'paused', detail: 'no-progress' }])
  })

  it('formats a notification id from the loop and event', () => {
    expect(
      buildLoopNotification({ id: 'loop-1', name: 'Fix tests', worktreeId: 'wt' }, 'completed')
    ).toEqual({
      title: 'Loop completed',
      body: 'Fix tests',
      notificationId: 'loop:loop-1:completed'
    })
  })
})

describe('LoopDriver shutdown', () => {
  it('stops without ending the iteration or the loop', async () => {
    const h = createHarness({})
    h.steps.push(
      (args) =>
        new Promise((resolve) => {
          args.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }))
          void h.driver.shutdown()
        })
    )

    await h.run()

    const row = h.row()
    expect(row.state).toBe('running')
    expect(h.store.listIterations('loop-1')[0]?.endedAt).toBeNull()
  })
})
