// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { IterationDetail, LoopsApi } from '../../../shared/fork-loops/api'
import type { IterationSummary, LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { getAgentLabel } from '@/lib/agent-catalog'
import { LoopRail } from './LoopRail'
import { LoopStatusStrip } from './use-terminal-pane-loop-rail'

const PANE_KEY = 'tab-1:leaf-1'
const initialState = useAppStore.getInitialState()

function iteration(overrides: Partial<IterationSummary> & { n: number }): IterationSummary {
  return {
    attempt: 0,
    startedAt: 1_000,
    endedAt: 66_000,
    endReason: 'settled',
    checkPass: true,
    evaluatorVerdict: null,
    added: 12,
    removed: 3,
    costUsd: null,
    ...overrides
  }
}

function iterationDetail(overrides: Partial<IterationDetail> & { n: number }): IterationDetail {
  return {
    attempt: 0,
    startedAt: 1_000,
    endedAt: 66_000,
    endReason: 'settled',
    check: {
      ran: true,
      pass: false,
      exitCode: 1,
      timedOut: false,
      stdoutTail: 'running 12 tests',
      stderrTail: 'FAIL parser.test.ts',
      durationMs: 900
    },
    evaluator: { verdict: 'not-met', reason: 'The parser still drops trailing commas.' },
    diff: { added: 12, removed: 3, files: ['parser.ts'] },
    treeBefore: null,
    treeAfter: null,
    costUsd: null,
    markers: [],
    protectedPathHits: [],
    checkpointCommit: null,
    outputTail: 'agent edited parser.ts',
    ...overrides
  }
}

function makeLoop(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    id: 'loop-1',
    worktreeId: 'wt-1',
    name: 'Fix the flaky tests',
    agent: 'claude',
    preset: 'until-done',
    config: {
      promptSource: { kind: 'repeat', body: 'keep going' },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'fresh',
      done: {},
      caps: { maxIterations: 10 },
      noProgress: true,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false
    },
    state: 'running',
    tab: { tabId: 'tab-1', paneKey: PANE_KEY },
    iterationsCompleted: 4,
    currentIteration: { n: 5, startedAt: 70_000, phase: 'working' },
    detached: false,
    skippedTicks: 0,
    activeMs: 120_000,
    recentIterations: [iteration({ n: 4 })],
    ...overrides
  }
}

function installApi(): { [K in keyof LoopsApi]: ReturnType<typeof vi.fn> } {
  const api = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    pause: vi.fn(async () => makeLoop({ state: 'paused' })),
    resume: vi.fn(async () => makeLoop()),
    stop: vi.fn(async () => makeLoop({ state: 'stopped' })),
    steer: vi.fn(async () => makeLoop()),
    edit: vi.fn(async () => makeLoop()),
    queue: vi.fn(),
    bindTab: vi.fn(),
    detach: vi.fn(),
    openTab: vi.fn(),
    iterations: vi.fn(async () => []),
    onChanged: vi.fn(() => () => {})
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { loops: api } })
  return api
}

function seed(loop: LoopSnapshot): void {
  act(() => {
    useAppStore.getState().applyLoopSnapshot(loop)
  })
}

let previousApi: unknown

beforeEach(() => {
  previousApi = window.api
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})

describe('LoopRail', () => {
  it('renders nothing for a pane that is not bound to a loop', () => {
    installApi()
    seed(makeLoop())

    const { container } = render(<LoopRail paneKey="tab-9:leaf-9" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('shows the loop name, status, and iteration progress against the cap', () => {
    installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)

    expect(screen.getByText('Fix the flaky tests')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Iteration 5 of 10')).toBeInTheDocument()
  })

  it('reads unverifiable instead of running while the host is unreachable', () => {
    installApi()
    seed(makeLoop({ unverifiableSince: 90_000 }))

    render(<LoopRail paneKey={PANE_KEY} />)

    expect(screen.getByText('Unverifiable')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
    expect(screen.getByText(/host is unreachable/)).toBeInTheDocument()
  })

  it('shows how many wall-clock ticks were skipped, and nothing when none were', () => {
    installApi()
    seed(makeLoop({ skippedTicks: 3 }))

    const { rerender } = render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('3 ticks skipped')).toBeInTheDocument()

    seed(makeLoop({ skippedTicks: 1 }))
    rerender(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('1 tick skipped')).toBeInTheDocument()

    seed(makeLoop({ skippedTicks: 0 }))
    rerender(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument()
  })

  it('pauses after the current iteration', async () => {
    const api = installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    })

    expect(api.pause).toHaveBeenCalledWith('loop-1', 'after-iteration')
  })

  it('lets Edit change the prompt, pacing, done signal, and options, not only name and caps', async () => {
    const api = installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByLabelText('Prompt')).toHaveValue('keep going')
    expect(screen.getByText('Pacing')).toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByLabelText('Done check command')).toBeInTheDocument()
    expect(screen.getByLabelText('Protected paths')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'ship it' } })
    fireEvent.change(screen.getByLabelText('Done check command'), {
      target: { value: 'pnpm test' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ask before each new iteration' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(api.edit).toHaveBeenCalledWith('loop-1', {
      promptSource: { kind: 'repeat', body: 'ship it' },
      done: { check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' } },
      askBeforeNext: true
    })
  })

  it('offers both stop modes and sends the chosen one', async () => {
    const api = installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'After this iteration' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Now' }))
    })

    expect(api.stop).toHaveBeenCalledWith('loop-1', 'now')
  })

  it('sends a steering note', async () => {
    const api = installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Steering note' }), {
      target: { value: 'focus on the parser' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })

    expect(api.steer).toHaveBeenCalledWith('loop-1', 'focus on the parser')
  })

  it('shows the pending decision text without a Resume, since the user answers in the terminal', () => {
    const api = installApi()
    seed(
      makeLoop({
        state: 'needs-you',
        pauseReason: 'agent-decide',
        pendingQuestion: { kind: 'decide', text: 'Use the old parser or rewrite it?' }
      })
    )

    render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('Use the old parser or rewrite it?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(api.resume).not.toHaveBeenCalled()
  })

  it('offers no Resume for a needs-you loop without a pending question', () => {
    installApi()
    seed(makeLoop({ state: 'needs-you', pauseReason: 'agent-blocked' }))

    render(<LoopRail paneKey={PANE_KEY} />)

    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it('opens the attempt that was clicked when an iteration was retried after a crash', () => {
    installApi()
    seed(
      makeLoop({
        recentIterations: [
          iteration({ n: 4, attempt: 0, endReason: 'crashed', checkPass: false }),
          iteration({ n: 4, attempt: 1, endReason: 'settled', checkPass: true })
        ]
      })
    )

    render(<LoopRail paneKey={PANE_KEY} />)
    const rows = screen.getAllByRole('button', { name: /Iteration 4/ })
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[0])

    expect(screen.getByText('Check passed')).toBeInTheDocument()
    expect(screen.queryByText('Check failed')).not.toBeInTheDocument()
  })

  it('opens an iteration row into its detail with the check result and diff counts', () => {
    installApi()
    seed(
      makeLoop({ recentIterations: [iteration({ n: 4, checkPass: false, added: 12, removed: 3 })] })
    )

    render(<LoopRail paneKey={PANE_KEY} />)
    fireEvent.click(screen.getByRole('button', { name: /Iteration 4/ }))

    expect(screen.getByText('Check failed')).toBeInTheDocument()
    expect(screen.getByText('12 added')).toBeInTheDocument()
    expect(screen.getByText('3 removed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: /Iteration 4/ })).toBeInTheDocument()
  })

  it('fetches the loop iterations when a row opens and shows check output, verdict, and agent output', async () => {
    const api = installApi()
    api.iterations.mockResolvedValue([iterationDetail({ n: 3 }), iterationDetail({ n: 4 })])
    seed(makeLoop({ recentIterations: [iteration({ n: 4, checkPass: false })] }))

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Iteration 4/ }))
    })

    expect(api.iterations).toHaveBeenCalledWith('loop-1')
    expect(screen.getByText('running 12 tests')).toBeInTheDocument()
    expect(screen.getByText('FAIL parser.test.ts')).toBeInTheDocument()
    expect(screen.getByText('The parser still drops trailing commas.')).toBeInTheDocument()
    expect(screen.getByText('agent edited parser.ts')).toBeInTheDocument()
  })

  it('shows the attempt that was opened, not another attempt of the same iteration', async () => {
    const api = installApi()
    api.iterations.mockResolvedValue([
      iterationDetail({ n: 4, attempt: 0, outputTail: 'crashed attempt output' }),
      iterationDetail({ n: 4, attempt: 1, outputTail: 'retry attempt output' })
    ])
    seed(
      makeLoop({
        recentIterations: [
          iteration({ n: 4, attempt: 0, endReason: 'crashed' }),
          iteration({ n: 4, attempt: 1 })
        ]
      })
    )

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Iteration 4/ })[0])
    })

    expect(screen.getByText('retry attempt output')).toBeInTheDocument()
    expect(screen.queryByText('crashed attempt output')).not.toBeInTheDocument()
  })

  it('shows a loading state until the iterations arrive', async () => {
    const api = installApi()
    let resolve: (value: IterationDetail[]) => void = () => {}
    api.iterations.mockReturnValue(new Promise<IterationDetail[]>((r) => (resolve = r)))
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Iteration 4/ }))
    })
    expect(screen.getByText('Loading output…')).toBeInTheDocument()

    await act(async () => {
      resolve([iterationDetail({ n: 4 })])
    })
    expect(screen.queryByText('Loading output…')).not.toBeInTheDocument()
    expect(screen.getByText('agent edited parser.ts')).toBeInTheDocument()
  })

  it('shows an error state when the iterations fetch fails', async () => {
    const api = installApi()
    api.iterations.mockRejectedValue(new Error('boom'))
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Iteration 4/ }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the output for this iteration.'
    )
    expect(screen.queryByText('Loading output…')).not.toBeInTheDocument()
  })

  it('shows a configured cost cap before any cost is measured, then the spend against it', () => {
    installApi()
    const config = { ...makeLoop().config, caps: { maxIterations: 10, maxCostUsd: 5 } }
    seed(makeLoop({ config }))

    const { rerender } = render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('Cost')).toBeInTheDocument()
    expect(screen.getByText('\u2014 of $5.00')).toBeInTheDocument()

    seed(makeLoop({ costUsd: 1.5, config }))
    rerender(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('$1.50 of $5.00')).toBeInTheDocument()
  })

  it('omits the cost meter when no cost cap is set and no cost was reported', () => {
    installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()
  })

  it('says cost is unavailable when the loop paused for lack of usage data', () => {
    installApi()
    seed(
      makeLoop({
        state: 'paused',
        pauseReason: 'cap-cost',
        pauseDetail: 'usage-unavailable',
        currentIteration: undefined,
        config: { ...makeLoop().config, caps: { maxIterations: 10, maxCostUsd: 5 } }
      })
    )

    render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('Cost unavailable')).toBeInTheDocument()
  })

  it('resumes a loop paused at its iteration cap with the chosen number of extra iterations', async () => {
    const api = installApi()
    seed(makeLoop({ state: 'paused', pauseReason: 'cap-iterations', currentIteration: undefined }))

    render(<LoopRail paneKey={PANE_KEY} />)
    const input = screen.getByRole('textbox', { name: 'Iterations to add' })
    expect(input).toHaveValue('5')
    fireEvent.change(input, { target: { value: '8' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    })

    expect(api.resume).toHaveBeenCalledWith('loop-1', { addIterations: 8 })
  })

  it('keeps a plain Resume for other pause reasons', async () => {
    const api = installApi()
    seed(makeLoop({ state: 'paused', pauseReason: 'user', currentIteration: undefined }))

    render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.queryByRole('textbox', { name: 'Iterations to add' })).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    })

    expect(api.resume).toHaveBeenCalledWith('loop-1')
  })
})

describe('LoopStatusStrip', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the iteration, agent, session policy, and elapsed time of the current iteration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    seed(makeLoop({ currentIteration: { n: 5, startedAt: 120_000, phase: 'working' } }))

    render(<LoopStatusStrip paneKey={PANE_KEY} />)

    expect(screen.getByRole('status', { name: 'Loop status' })).toHaveTextContent(
      `Iteration 5 · ${getAgentLabel('claude')} · fresh session · 3m 00s`
    )
  })

  it('reads unverifiable and freezes the elapsed time while the host is unreachable', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    seed(
      makeLoop({
        currentIteration: { n: 5, startedAt: 120_000, phase: 'working' },
        unverifiableSince: 180_000
      })
    )

    render(<LoopStatusStrip paneKey={PANE_KEY} />)
    const strip = screen.getByRole('status', { name: 'Loop status' })
    expect(strip).toHaveTextContent(
      `Iteration 5 · Unverifiable · ${getAgentLabel('claude')} · fresh session · 1m 00s`
    )

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(strip).toHaveTextContent('1m 00s')
  })

  it('renders nothing for a pane that is not bound to a loop', () => {
    seed(makeLoop())

    const { container } = render(<LoopStatusStrip paneKey="tab-9:leaf-9" />)

    expect(container).toBeEmptyDOMElement()
  })
})
