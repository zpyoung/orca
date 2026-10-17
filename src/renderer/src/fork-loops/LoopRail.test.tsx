// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { LoopsApi } from '../../../shared/fork-loops/api'
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

  it('pauses after the current iteration', async () => {
    const api = installApi()
    seed(makeLoop())

    render(<LoopRail paneKey={PANE_KEY} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    })

    expect(api.pause).toHaveBeenCalledWith('loop-1', 'after-iteration')
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

  it('hides the cost meter when the loop has reported no cost', () => {
    installApi()
    seed(makeLoop({ config: { ...makeLoop().config, caps: { maxIterations: 10, maxCostUsd: 5 } } }))

    const { rerender } = render(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.queryByText('Cost')).not.toBeInTheDocument()

    seed(
      makeLoop({
        costUsd: 1.5,
        config: { ...makeLoop().config, caps: { maxIterations: 10, maxCostUsd: 5 } }
      })
    )
    rerender(<LoopRail paneKey={PANE_KEY} />)
    expect(screen.getByText('Cost')).toBeInTheDocument()
    expect(screen.getByText('$1.50 of $5.00')).toBeInTheDocument()
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

  it('renders nothing for a pane that is not bound to a loop', () => {
    seed(makeLoop())

    const { container } = render(<LoopStatusStrip paneKey="tab-9:leaf-9" />)

    expect(container).toBeEmptyDOMElement()
  })
})
