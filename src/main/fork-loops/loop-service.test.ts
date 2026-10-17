import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CheckOutcome,
  LoopConfig,
  LoopCreateInput,
  LoopSnapshot
} from '../../shared/fork-loops/loop-types'
import type { PtyLivenessVerdict } from '../../shared/pty-liveness-verdict'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'
import { LoopDatabase, type LoopInsert } from './loop-database'
import type { IterationSettlement, ObserveIterationArgs } from './iteration-observer'
import type { LoopCheckTarget } from './loop-check'
import type { LoopEvidenceTools, LoopTargets } from './loop-driver'
import { LoopService, type LoopServiceDeps, type LoopServiceRuntime } from './loop-service'
import { LoopStore } from './loop-store'

const CONFIG: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'fix the failing tests' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'continue',
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
  durationMs: 1
}

const INPUT: LoopCreateInput = {
  worktreeId: 'wt-1',
  name: 'Fix tests',
  agent: 'claude',
  preset: 'until-done',
  config: CONFIG
}

const databases: LoopDatabase[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Options = {
  runtime?: 'full' | 'partial'
  checkTarget?: LoopCheckTarget
  evaluatorAvailable?: boolean
  hold?: boolean
  unverifiableFirst?: boolean
  workspace?: Partial<LoopTargets['workspace']>
}

function createHarness(options: Options = {}) {
  const database = new LoopDatabase(':memory:')
  databases.push(database)
  const connection = vi.spyOn(database, 'connection')
  const state = { clock: 5_000_000, launches: 0 }
  const store = new LoopStore(database, () => state.clock)
  const panes = new Map<string, { handle: string; ptyId: string }>()
  const prompts: { handle: string; prompt: string }[] = []
  const gate = deferred<IterationSettlement>()

  const runtime = {
    launchAgentTerminal: vi.fn(async (): Promise<RuntimeTerminalCreate> => {
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
    }),
    closeTerminalTab: vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab',
      closeMode: 'tab' as const,
      ptyKilled: true
    })),
    focusTerminal: vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab-0',
      worktreeId: 'wt-1'
    })),
    sendTerminalAgentPrompt: vi.fn(async (handle: string, prompt: string) => {
      prompts.push({ handle, prompt })
      return {}
    }),
    getTerminalHandleForPaneKey: (paneKey: string) => panes.get(paneKey)?.handle ?? null,
    getTerminalPtyIdForHandle: (handle: string) =>
      [...panes.values()].find((pane) => pane.handle === handle)?.ptyId ?? null,
    getPtyLivenessVerdict: vi.fn((ptyId: string): PtyLivenessVerdict => ({
      status: 'live',
      ptyIds: [ptyId]
    }))
  } satisfies LoopServiceRuntime

  const tools = {
    snapshotTree: vi.fn(async () => null),
    diffTrees: vi.fn(async () => ({ added: 0, removed: 0, files: [] })),
    runCheck: vi.fn(async () => PASS),
    evaluate: vi.fn(async () => ({ verdict: 'met' as const, reason: 'ok' })),
    readUsage: vi.fn(async () => null),
    readUsageLimit: vi.fn(() => null)
  } satisfies LoopEvidenceTools

  const targets: LoopTargets = {
    executionHostId: 'local',
    check: options.checkTarget ?? { type: 'local', cwd: '/work' },
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
      runGit: async () => ({ stdout: '.git/info/exclude', stderr: '' }),
      ...options.workspace
    }
  }

  let observeCalls = 0
  const observeIteration = vi.fn((args: ObserveIterationArgs): Promise<IterationSettlement> => {
    state.clock += 1000
    if (options.unverifiableFirst && observeCalls === 0) {
      observeCalls += 1
      return Promise.resolve({ kind: 'unverifiable' })
    }
    if (!options.hold) {
      return Promise.resolve({ kind: 'settled', settledAt: state.clock })
    }
    return new Promise((resolve) => {
      void gate.promise.then(resolve)
      args.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }))
    })
  })

  const notifications: string[] = []
  const closeDatabase = vi.fn(() => database.close())
  const deps: LoopServiceDeps = {
    store,
    runtime: options.runtime === 'partial' ? {} : runtime,
    driverDeps: {
      observer: { observeIteration },
      inputAttribution: { noteLoopWrite: vi.fn(), userIdleFor: () => true },
      tools,
      targets: async () => targets,
      now: () => state.clock,
      sleep: async (ms) => {
        state.clock += ms
      },
      pollMs: 10
    },
    notify: (_loop, event) => notifications.push(event),
    closeDatabase,
    isEvaluatorAvailable: () => options.evaluatorAvailable ?? true,
    now: () => state.clock,
    newId: (() => {
      let n = 0
      return () => `00000000-0000-4000-8000-00000000000${(n += 1)}`
    })()
  }
  const service = new LoopService(deps)
  const snapshots: LoopSnapshot[] = []
  service.onChange((snapshot) => snapshots.push(snapshot))

  const seed = (insert: Partial<LoopInsert> = {}) =>
    store.insertLoop({
      id: 'loop-seed',
      worktreeId: 'wt-1',
      workspaceKind: 'git',
      executionHostId: 'local',
      name: 'Seed',
      slug: 'seed-1',
      agent: 'claude',
      preset: 'until-done',
      config: CONFIG,
      state: 'paused',
      pauseReason: 'user',
      tabId: 'tab-0',
      paneKey: 'tab-0:leaf-0',
      ptyId: 'pty-0',
      ...insert
    })

  return {
    service,
    store,
    runtime,
    tools,
    state,
    panes,
    prompts,
    snapshots,
    gate,
    observeIteration,
    notifications,
    closeDatabase,
    connection,
    seed,
    addPane: (paneKey: string, handle: string, ptyId: string) =>
      panes.set(paneKey, { handle, ptyId })
  }
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error && 'code' in error ? error.code : undefined
  }
  return undefined
}

describe('LoopService.create', () => {
  it('launches the agent in the worktree, persists the pane, and publishes once with warnings', async () => {
    const h = createHarness({ hold: true })

    const snapshot = await h.service.create(INPUT)

    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: '',
      title: 'Fix tests'
    })
    expect(snapshot.state).toBe('running')
    expect(snapshot.tab).toEqual({ tabId: 'tab-1', paneKey: 'tab-1:leaf-1' })
    expect(snapshot.warnings).toBeUndefined()
    expect(h.snapshots[0]).toEqual(snapshot)
    const row = h.store.getLoop(snapshot.id)
    expect(row?.ptyId).toBe('pty-1')
    expect(row?.workspaceKind).toBe('git')
    expect(row?.slug).toMatch(/^fix-tests-[0-9a-f]{8}$/)
  })

  it('closes the launch and persists nothing when it reports no pty identity', async () => {
    const h = createHarness()
    h.runtime.launchAgentTerminal.mockImplementationOnce(async () => ({
      handle: 'term-orphan',
      tabId: 'tab-9',
      paneKey: 'tab-9:leaf-9',
      worktreeId: 'wt-1',
      title: 'Fix tests'
    }))

    await expect(h.service.create(INPUT)).rejects.toThrow(
      'agent launch did not report its tab identity'
    )

    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-orphan')
    expect(h.store.listLoops()).toEqual([])
    expect(h.observeIteration).not.toHaveBeenCalled()
  })

  it('warns when another loop is already running in the worktree', async () => {
    const h = createHarness({ hold: true })
    await h.service.create(INPUT)

    const second = await h.service.create({ ...INPUT, name: 'Second' })

    expect(second.warnings).toEqual(['worktree-has-running-loop'])
  })

  it('inserts initial queue items before the driver starts so the first prompt uses one', async () => {
    const h = createHarness()
    const input: LoopCreateInput = {
      ...INPUT,
      preset: 'queue',
      config: { ...CONFIG, promptSource: { kind: 'queue', repeatQueue: false }, done: {} },
      queueItems: ['write the parser', 'add tests']
    }

    const created = await h.service.create(input)
    await vi.waitFor(() => expect(h.store.getLoop(created.id)?.state).toBe('completed'))

    expect(h.prompts).toHaveLength(2)
    expect(h.prompts[0]?.prompt).toContain('write the parser')
    expect(h.prompts[1]?.prompt).toContain('add tests')
  })

  it('closes the launched terminal and persists nothing when the insert fails', async () => {
    const h = createHarness({ hold: true })
    vi.spyOn(h.store, 'insertLoop').mockImplementation(() => {
      throw new Error('database is read-only')
    })

    await expect(h.service.create(INPUT)).rejects.toThrow('database is read-only')

    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-1')
    expect(h.store.listLoops()).toEqual([])
    expect(h.snapshots).toEqual([])
  })

  it('stops the loop, closes the terminal, and never starts a driver when queue seeding fails', async () => {
    const h = createHarness({ hold: true })
    vi.spyOn(h.store, 'applyQueueOp').mockImplementation(() => {
      throw new Error('queue write failed')
    })

    await expect(h.service.create({ ...INPUT, queueItems: ['one'] })).rejects.toThrow(
      'queue write failed'
    )

    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-1')
    expect(h.store.listLoops().map((loop) => loop.state)).toEqual(['stopped'])
    expect(h.observeIteration).not.toHaveBeenCalled()
    expect(h.snapshots).toEqual([])
  })

  it('fails creation, closes the terminal, and persists nothing when the notes file cannot be written', async () => {
    const files = new Map<string, string>()
    const h = createHarness({
      hold: true,
      workspace: {
        fs: {
          readFile: async (path) => ({ content: files.get(path) ?? '', isBinary: false }),
          writeFile: async () => {
            throw new Error('disk full')
          },
          createDir: async () => undefined,
          deletePath: async () => undefined,
          stat: async (path) => {
            if (!files.has(path)) {
              throw new Error('missing')
            }
            return { size: 0, type: 'file', mtime: 0, mtimeMs: 0 }
          }
        }
      }
    })

    await expect(h.service.create(INPUT)).rejects.toThrow('disk full')

    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-1')
    expect(h.store.listLoops()).toEqual([])
    expect(h.snapshots).toEqual([])
  })

  it('fails creation, closing the terminal, when the git exclude update fails', async () => {
    const files = new Map<string, string>()
    const h = createHarness({
      hold: true,
      workspace: {
        fs: {
          readFile: async (path) => ({ content: files.get(path) ?? '', isBinary: false }),
          writeFile: async (path, content) => {
            files.set(path, content)
          },
          createDir: async () => undefined,
          deletePath: async () => undefined,
          stat: async (path) => {
            if (!files.has(path)) {
              throw new Error('missing')
            }
            return { size: 0, type: 'file', mtime: 0, mtimeMs: 0 }
          }
        },
        runGit: async () => {
          throw new Error('git unavailable')
        }
      }
    })

    await expect(h.service.create(INPUT)).rejects.toThrow('git unavailable')

    expect(h.runtime.closeTerminalTab).toHaveBeenCalledWith('term-1')
    expect(h.store.listLoops()).toEqual([])
  })

  it('fails creation for a git workspace that has no way to run git', async () => {
    const h = createHarness({ hold: true, workspace: { runGit: null } })

    await expect(h.service.create(INPUT)).rejects.toThrow('cannot be excluded')

    expect(h.store.listLoops()).toEqual([])
  })

  it('publishes unverifiableSince only while the driver holds on an unreachable host', async () => {
    const h = createHarness({ unverifiableFirst: true })
    const observed: (number | undefined)[] = []
    h.runtime.getPtyLivenessVerdict.mockImplementation((ptyId: string) => {
      observed.push(h.service.list()[0]?.unverifiableSince)
      return { status: 'live', ptyIds: [ptyId] }
    })

    const created = await h.service.create(INPUT)
    await vi.waitFor(() => expect(h.service.get(created.id)?.state).toBe('completed'))

    expect(observed.length).toBeGreaterThan(0)
    // later calls come from the between-iterations probe, which runs outside the hold
    expect(observed[0]).toEqual(expect.any(Number))
    expect(h.snapshots.some((snapshot) => snapshot.unverifiableSince !== undefined)).toBe(true)
    expect(h.service.get(created.id)?.unverifiableSince).toBeUndefined()
  })

  it('surfaces the original error even when closing the terminal also fails', async () => {
    const h = createHarness({ hold: true })
    vi.spyOn(h.store, 'insertLoop').mockImplementation(() => {
      throw new Error('database is read-only')
    })
    h.runtime.closeTerminalTab.mockRejectedValueOnce(new Error('close failed'))

    await expect(h.service.create(INPUT)).rejects.toThrow('database is read-only')
  })

  it('populates the snapshot queue in position order', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create({
      ...INPUT,
      preset: 'queue',
      config: { ...CONFIG, promptSource: { kind: 'queue', repeatQueue: false }, done: {} },
      queueItems: ['first', 'second']
    })

    expect(created.queue?.map((item) => [item.position, item.body, item.state])).toEqual([
      [0, 'first', 'pending'],
      [1, 'second', 'pending']
    ])
    const added = await h.service.queue(created.id, { op: 'add', body: 'third', position: 0 })
    expect(added.queue?.map((item) => item.body)).toEqual(['third', 'first', 'second'])
    expect(h.service.get(created.id)?.queue).toEqual(added.queue)
  })

  it('rejects a check on a Windows SSH host', async () => {
    const h = createHarness({
      checkTarget: { type: 'ssh', cwd: '/w', connectionId: 'c', remotePlatform: 'win32' }
    })

    expect(await codeOf(h.service.create(INPUT))).toBe('loop_check_unsupported_host')
    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('rejects an evaluator when its CLI is not installed', async () => {
    const h = createHarness({ evaluatorAvailable: false })
    const input = {
      ...INPUT,
      config: { ...CONFIG, done: { evaluator: { condition: 'tests are green' } } }
    }

    expect(await codeOf(h.service.create(input))).toBe('loop_evaluator_unavailable')
  })

  it('reports an unavailable runtime for a partial runtime double', async () => {
    const h = createHarness({ runtime: 'partial' })

    expect(await codeOf(h.service.create(INPUT))).toBe('loop_runtime_unavailable')
    expect(h.service.list()).toEqual([])
  })
})

describe('LoopService lazy database', () => {
  it('does not open the database until the first call', () => {
    const h = createHarness()
    expect(h.connection).not.toHaveBeenCalled()

    h.service.list()

    expect(h.connection).toHaveBeenCalled()
  })
})

describe('LoopService.start reconcile', () => {
  it('pauses loops left running, closes their open iteration, and never auto-resumes', () => {
    const h = createHarness()
    h.seed({ id: 'loop-a', state: 'running', pauseReason: undefined })
    h.seed({ id: 'loop-b', state: 'needs-you', pauseReason: undefined })
    h.seed({ id: 'loop-c', state: 'completed', pauseReason: undefined })
    h.store.insertIteration('loop-a', { n: 1, attempt: 0, promptSent: 'p', startedAt: 1 })

    h.service.start()

    expect(h.store.getLoop('loop-a')?.state).toBe('paused')
    expect(h.store.getLoop('loop-a')?.pauseReason).toBe('interrupted-by-restart')
    expect(h.store.getLoop('loop-b')?.pauseReason).toBe('interrupted-by-restart')
    expect(h.store.getLoop('loop-c')?.state).toBe('completed')
    const [iteration] = h.store.listIterations('loop-a')
    expect(iteration?.endReason).toBe('interrupted')
    expect(iteration?.endedAt).not.toBeNull()
    expect(h.snapshots.map((s) => s.id).sort()).toEqual(['loop-a', 'loop-b'])
    expect(h.observeIteration).not.toHaveBeenCalled()
  })

  it('relaunches in the background and reruns the interrupted iteration when its pane is gone', async () => {
    const h = createHarness()
    h.seed({ state: 'running', pauseReason: undefined })
    h.store.insertIteration('loop-seed', { n: 1, attempt: 0, promptSent: 'p', startedAt: 1 })
    h.service.start()

    await h.service.resume('loop-seed')
    await vi.waitFor(() => expect(h.store.getLoop('loop-seed')?.state).toBe('completed'))

    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
    const rows = h.store.listIterations('loop-seed')
    expect(rows.map((it) => [it.n, it.attempt, it.endReason])).toEqual([
      [1, 0, 'interrupted'],
      [1, 1, 'settled']
    ])
    expect(h.prompts[0]?.handle).toBe('term-1')
    expect(h.store.getLoop('loop-seed')?.paneKey).toBe('tab-1:leaf-1')
  })

  it('reruns the interrupted iteration in the existing pane when it is still live', async () => {
    const h = createHarness()
    h.addPane('tab-0:leaf-0', 'term-0', 'pty-0')
    h.seed({ state: 'running', pauseReason: undefined })
    h.store.insertIteration('loop-seed', { n: 1, attempt: 0, promptSent: 'p', startedAt: 1 })
    h.service.start()

    await h.service.resume('loop-seed')
    await vi.waitFor(() => expect(h.store.getLoop('loop-seed')?.state).toBe('completed'))

    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
    expect(h.prompts[0]?.handle).toBe('term-0')
  })
})

describe('LoopService iteration retention', () => {
  function seedIterations(h: ReturnType<typeof createHarness>, loopId: string, count: number) {
    for (let n = 1; n <= count; n += 1) {
      h.store.insertIteration(loopId, { n, attempt: 0, promptSent: 'p', startedAt: n })
    }
  }

  it('trims loops that ended before this process when the service starts', () => {
    const h = createHarness()
    h.seed({ id: 'loop-done', state: 'completed', pauseReason: undefined })
    h.seed({ id: 'loop-open', slug: 'open-1', state: 'paused' })
    seedIterations(h, 'loop-done', 201)
    seedIterations(h, 'loop-open', 201)

    h.service.start()

    expect(h.store.listIterations('loop-done')).toHaveLength(200)
    expect(h.store.listIterations('loop-open')).toHaveLength(201)
  })

  it('trims a loop when it reaches an ended state', async () => {
    const h = createHarness()
    h.seed({ state: 'paused' })
    seedIterations(h, 'loop-seed', 201)
    h.service.start()
    expect(h.store.listIterations('loop-seed')).toHaveLength(201)

    await h.service.stop('loop-seed', 'now')

    expect(h.store.getLoop('loop-seed')?.state).toBe('stopped')
    expect(h.store.listIterations('loop-seed')).toHaveLength(200)
  })

  it('logs and ignores a failed prune', async () => {
    const h = createHarness()
    h.seed({ state: 'paused' })
    vi.spyOn(h.store, 'pruneEndedLoopIterations').mockImplementation(() => {
      throw new Error('disk full')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => h.service.start()).not.toThrow()
    const stopped = await h.service.stop('loop-seed', 'now')

    expect(stopped.state).toBe('stopped')
    expect(warn).toHaveBeenCalledWith('[loops] iteration retention failed:', expect.any(Error))
    warn.mockRestore()
  })
})

describe('LoopService transitions', () => {
  it('emits exactly one change per mutation on a paused loop', async () => {
    const h = createHarness()
    h.seed({ state: 'paused' })

    await h.service.steer('loop-seed', 'be careful')
    await h.service.edit('loop-seed', { name: 'Renamed' })
    await h.service.detach('loop-seed')
    await h.service.queue('loop-seed', { op: 'add', body: 'next' })

    expect(h.snapshots).toHaveLength(4)
    expect(h.snapshots.at(-1)?.name).toBe('Renamed')
    expect(h.snapshots.at(-1)?.detached).toBe(true)
  })

  it('stops a paused loop immediately and rejects further transitions', async () => {
    const h = createHarness()
    h.seed({ state: 'paused' })

    const stopped = await h.service.stop('loop-seed', 'now')

    expect(stopped.state).toBe('stopped')
    expect(stopped.pauseReason).toBeUndefined()
    expect(await codeOf(h.service.resume('loop-seed'))).toBe('loop_invalid_transition')
    expect(await codeOf(h.service.stop('loop-seed', 'now'))).toBe('loop_invalid_transition')
    expect(await codeOf(h.service.steer('loop-seed', 'x'))).toBe('loop_invalid_transition')
  })

  it('reports an unknown loop', async () => {
    const h = createHarness()

    expect(await codeOf(h.service.pause('missing', 'after-iteration'))).toBe('loop_not_found')
    expect(h.service.get('missing')).toBeNull()
  })

  it('only resumes a paused loop', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create(INPUT)

    expect(await codeOf(h.service.resume(created.id))).toBe('loop_invalid_transition')
  })

  it('pauses a running loop after its iteration and resumes it', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create(INPUT)
    await vi.waitFor(() => expect(h.observeIteration).toHaveBeenCalled())

    await h.service.pause(created.id, 'after-iteration')
    h.gate.resolve({ kind: 'settled', settledAt: h.state.clock })
    await vi.waitFor(() => expect(h.store.getLoop(created.id)?.state).toBe('paused'))
    expect(h.store.getLoop(created.id)?.pauseReason).toBe('user')

    h.observeIteration.mockImplementation(() => Promise.resolve({ kind: 'settled', settledAt: 1 }))
    await h.service.resume(created.id)
    await vi.waitFor(() => expect(h.store.getLoop(created.id)?.state).toBe('completed'))
    expect(h.store.getLoop(created.id)?.iterationsCompleted).toBe(2)
  })

  it('adds iterations to the cap on resume', async () => {
    const h = createHarness()
    h.seed({
      state: 'paused',
      pauseReason: 'cap-iterations',
      iterationsCompleted: 2,
      config: { ...CONFIG, caps: { maxIterations: 2 }, done: {}, askBeforeNext: true }
    })

    const resumed = await h.service.resume('loop-seed', { addIterations: 3 })

    expect(resumed.config.caps.maxIterations).toBe(5)
    expect(resumed.state).toBe('running')
    expect(resumed.pauseReason).toBeUndefined()
    await vi.waitFor(() => expect(h.store.getLoop('loop-seed')?.state).toBe('paused'))
  })

  it('rejects an edit of an in-flight queue item', async () => {
    const h = createHarness()
    h.seed({ state: 'paused' })
    await h.service.queue('loop-seed', { op: 'add', body: 'one' })
    const [item] = h.store.listQueue('loop-seed')
    h.store.setQueueItemState('loop-seed', item?.id ?? '', 'in-flight')

    const code = await codeOf(
      h.service.queue('loop-seed', { op: 'edit', id: item?.id ?? '', body: 'changed' })
    )

    expect(code).toBe('loop_invalid_transition')
  })

  it('shows the agent question on a loop paused by a marker', async () => {
    const h = createHarness()
    h.seed({ state: 'paused', pauseReason: 'agent-decide' })
    h.store.insertIteration('loop-seed', {
      n: 1,
      attempt: 0,
      promptSent: 'p',
      startedAt: 1,
      endedAt: 2,
      endReason: 'settled',
      markers: [{ kind: 'decide', text: 'Which database?' }]
    })

    expect(h.service.get('loop-seed')?.pendingQuestion).toEqual({
      kind: 'decide',
      text: 'Which database?'
    })
  })

  it('summarizes recent iterations and the live phase on a running loop', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create(INPUT)
    await vi.waitFor(() => expect(h.observeIteration).toHaveBeenCalled())

    const live = h.service.get(created.id)

    expect(live?.currentIteration?.n).toBe(1)
    expect(live?.currentIteration?.phase).toBe('working')
    expect(live?.recentIterations).toHaveLength(1)
    expect(live?.recentIterations[0]?.endedAt).toBeNull()
  })
})

describe('LoopService.listIterations', () => {
  function seedIterations(h: ReturnType<typeof createHarness>): void {
    h.seed()
    for (const n of [1, 2, 3]) {
      h.store.insertIteration('loop-seed', {
        n,
        attempt: 0,
        promptSent: `prompt ${n}`,
        startedAt: n * 1000,
        endedAt: n * 1000 + 500,
        endReason: 'settled',
        check: { ...PASS, stdoutTail: `check out ${n}`, stderrTail: `check err ${n}` },
        outputTail: `agent out ${n}`
      })
    }
    h.store.insertIteration('loop-seed', { n: 4, attempt: 0, promptSent: 'open', startedAt: 4000 })
  }

  it('returns finished iterations oldest first with check tails and the agent output tail', () => {
    const h = createHarness()
    seedIterations(h)

    const records = h.service.listIterations('loop-seed')

    expect(records.map((record) => record.n)).toEqual([1, 2, 3])
    expect(records[2]).toMatchObject({
      n: 3,
      attempt: 0,
      endReason: 'settled',
      outputTail: 'agent out 3',
      check: { stdoutTail: 'check out 3', stderrTail: 'check err 3' },
      markers: [],
      protectedPathHits: []
    })
  })

  it('keeps only the newest iterations when limited, still oldest first', () => {
    const h = createHarness()
    seedIterations(h)
    h.store.updateIteration('loop-seed', 4, 0, { endedAt: 4500, endReason: 'settled' })

    expect(h.service.listIterations('loop-seed', { limit: 2 }).map((r) => r.n)).toEqual([3, 4])
  })

  it('returns the newest finished iterations when an open one is the latest row', () => {
    const h = createHarness()
    seedIterations(h)

    expect(h.service.listIterations('loop-seed', { limit: 2 }).map((r) => r.n)).toEqual([2, 3])
  })

  it('reports an unknown loop without publishing a change', () => {
    const h = createHarness()

    expect(() => h.service.listIterations('missing')).toThrowError(
      expect.objectContaining({ code: 'loop_not_found' })
    )
    expect(h.snapshots).toHaveLength(0)
  })
})

describe('LoopService tab binding', () => {
  it('detaches a loop so its snapshot carries no tab, then reopens it in a revealed tab', async () => {
    const h = createHarness()
    h.addPane('tab-0:leaf-0', 'term-0', 'pty-0')
    h.seed({ state: 'paused' })

    const detached = await h.service.detach('loop-seed')
    expect(detached.detached).toBe(true)
    expect(detached.tab).toBeUndefined()

    const reopened = await h.service.openTab('loop-seed')

    expect(h.runtime.focusTerminal).toHaveBeenCalledWith('term-0')
    expect(reopened.detached).toBe(false)
    expect(reopened.tab).toEqual({ tabId: 'tab-0', paneKey: 'tab-0:leaf-0' })
  })

  it('binds only a pane that hosts the loop agent pty', async () => {
    const h = createHarness()
    h.addPane('tab-9:leaf-9', 'term-9', 'pty-other')
    h.addPane('tab-0:leaf-0', 'term-0', 'pty-0')
    h.seed({ state: 'paused' })

    expect(
      await codeOf(h.service.bindTab('loop-seed', { tabId: 'tab-9', paneKey: 'tab-9:leaf-9' }))
    ).toBe('loop_invalid_transition')
    expect(
      await codeOf(h.service.bindTab('loop-seed', { tabId: 'tab-x', paneKey: 'tab-0:leaf-0' }))
    ).toBe('loop_invalid_transition')

    const bound = await h.service.bindTab('loop-seed', { tabId: 'tab-0', paneKey: 'tab-0:leaf-0' })

    expect(bound.tab).toEqual({ tabId: 'tab-0', paneKey: 'tab-0:leaf-0' })
  })

  it('reports an unavailable runtime when it cannot resolve panes or reveal terminals', async () => {
    const h = createHarness({ runtime: 'partial' })
    h.seed({ state: 'paused' })

    expect(
      await codeOf(h.service.bindTab('loop-seed', { tabId: 'tab-0', paneKey: 'tab-0:leaf-0' }))
    ).toBe('loop_runtime_unavailable')
    expect(await codeOf(h.service.openTab('loop-seed'))).toBe('loop_runtime_unavailable')
  })

  it('relaunches the agent in a new tab and binds it when the background terminal is gone', async () => {
    const h = createHarness()
    h.seed({ state: 'paused', detached: true })

    const reopened = await h.service.openTab('loop-seed')

    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledWith('id:wt-1', {
      agent: 'claude',
      prompt: '',
      title: 'Seed'
    })
    expect(h.runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(reopened.detached).toBe(false)
    expect(reopened.tab).toEqual({ tabId: 'tab-1', paneKey: 'tab-1:leaf-1' })
    expect(h.store.getLoop('loop-seed')?.ptyId).toBe('pty-1')
  })

  it('launches once when the terminal is reopened twice at the same time', async () => {
    const h = createHarness()
    h.seed({ state: 'paused', detached: true })

    const codes = await Promise.all([
      codeOf(h.service.openTab('loop-seed')),
      codeOf(h.service.openTab('loop-seed'))
    ])

    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
    expect(codes).toContain('loop_invalid_transition')
  })

  it('refuses to reopen the terminal of an ended loop', async () => {
    const h = createHarness()
    h.seed({ state: 'stopped' })

    expect(await codeOf(h.service.openTab('loop-seed'))).toBe('loop_invalid_transition')
    expect(h.runtime.launchAgentTerminal).not.toHaveBeenCalled()
  })

  it('refuses to reopen the terminal while an iteration is running', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create(INPUT)
    await vi.waitFor(() => expect(h.observeIteration).toHaveBeenCalled())
    h.panes.clear()

    expect(await codeOf(h.service.openTab(created.id))).toBe('loop_invalid_transition')
    expect(h.runtime.launchAgentTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('LoopService.shutdown', () => {
  it('stops drivers without ending their loops and closes the database', async () => {
    const h = createHarness({ hold: true })
    const created = await h.service.create(INPUT)
    await vi.waitFor(() => expect(h.observeIteration).toHaveBeenCalled())
    const count = h.snapshots.length

    await h.service.shutdown()

    expect(h.closeDatabase).toHaveBeenCalledTimes(1)
    expect(h.snapshots).toHaveLength(count)
    h.gate.resolve({ kind: 'settled', settledAt: 1 })
    expect(created.state).toBe('running')
  })
})
