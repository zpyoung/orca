// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoopCreateInputSchema } from '../../../shared/fork-loops/loop-types'
import { LoopSetupDialog } from './LoopSetupDialog'

type MockState = {
  settings: { defaultTuiAgent: string; disabledTuiAgents: string[] }
  loopsById: Record<string, unknown>
  applyLoopSnapshot: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const state: MockState = {
    settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [] },
    loopsById: {},
    applyLoopSnapshot: vi.fn()
  }
  const detectedIds: string[] = ['claude', 'gemini']
  const target: { kind: string } = { kind: 'local' }
  return { state, detectedIds, target, create: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: mocks.detectedIds })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => mocks.target
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

// Radix Select mounts its content in a portal only once opened; the native swap keeps every
// option in the document so tests drive it with a plain change event.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children
  }: {
    value: string
    disabled?: boolean
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

function renderDialog(): { onOpenChange: ReturnType<typeof vi.fn> } {
  const onOpenChange = vi.fn()
  render(<LoopSetupDialog open worktreeId="wt-1" onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

function selectWithOption(value: string): HTMLElement {
  const select = screen
    .getAllByRole('combobox')
    .find((element) => element.querySelector(`option[value="${value}"]`))
  if (!select) {
    throw new Error(`no select offers ${value}`)
  }
  return select
}

function sessionSelect(): HTMLElement {
  return selectWithOption('continue')
}

async function submittedInput(): Promise<ReturnType<typeof LoopCreateInputSchema.parse>> {
  fireEvent.click(screen.getByRole('button', { name: 'Start loop' }))
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
  return mocks.create.mock.calls[0][0]
}

function enterCheckCommand(): void {
  openAdvanced()
  fireEvent.change(screen.getByLabelText('Done check command'), { target: { value: 'pnpm test' } })
}

function openAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
}

beforeEach(() => {
  mocks.state.loopsById = {}
  mocks.state.applyLoopSnapshot.mockReset()
  mocks.detectedIds = ['claude', 'gemini']
  mocks.target = { kind: 'local' }
  mocks.create.mockReset()
  mocks.create.mockImplementation(async () => ({ id: 'loop-1' }))
  Object.defineProperty(window, 'api', {
    value: { loops: { create: mocks.create } },
    configurable: true
  })
})

afterEach(cleanup)

describe('LoopSetupDialog', () => {
  it('pre-fills the iteration cap at 10 and lets it be cleared', () => {
    renderDialog()
    const cap = screen.getByLabelText('Maximum iterations')
    expect(cap).toHaveValue('10')
    fireEvent.change(cap, { target: { value: '' } })
    expect(cap).toHaveValue('')
  })

  it('shows cost fields only for Claude or Codex on a local host', () => {
    renderDialog()
    openAdvanced()
    expect(screen.getByLabelText('Maximum cost (USD)')).toBeInTheDocument()

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'gemini' } })
    expect(screen.queryByLabelText('Maximum cost (USD)')).not.toBeInTheDocument()
  })

  it('hides cost fields for Claude on a remote host', () => {
    mocks.target = { kind: 'ssh' }
    renderDialog()
    openAdvanced()
    expect(screen.queryByLabelText('Maximum cost (USD)')).not.toBeInTheDocument()
  })

  it('sets the session default when the preset changes', () => {
    renderDialog()
    expect(sessionSelect()).toHaveValue('fresh')
    fireEvent.click(screen.getByRole('radio', { name: 'On an interval' }))
    expect(sessionSelect()).toHaveValue('continue')
    fireEvent.click(screen.getByRole('radio', { name: 'Until done' }))
    expect(sessionSelect()).toHaveValue('fresh')
  })

  it('blocks submit when the interval is 0', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'On an interval' }))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'poll the queue' } })
    fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Start loop' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start loop' }))
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('submits a LoopCreateInput for an until-done loop and closes', async () => {
    const { onOpenChange } = renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'fix the tests' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start loop' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const input = mocks.create.mock.calls[0][0]
    expect(LoopCreateInputSchema.safeParse(input).success).toBe(true)
    expect(input).toEqual({
      worktreeId: 'wt-1',
      name: 'fix the tests',
      agent: 'claude',
      preset: 'until-done',
      config: {
        promptSource: { kind: 'repeat', body: 'fix the tests' },
        pacing: { kind: 'on-idle' },
        sessionPolicy: 'fresh',
        done: {},
        caps: { maxIterations: 10 },
        noProgress: true,
        checkpointCommits: false,
        askBeforeNext: false,
        resumeAtLimitReset: false
      }
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(mocks.state.applyLoopSnapshot).toHaveBeenCalledWith({ id: 'loop-1' })
  })

  it('omits the cap from the payload once it is cleared', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    fireEvent.change(screen.getByLabelText('Maximum iterations'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start loop' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create.mock.calls[0][0].config.caps).toEqual({})
  })

  it('warns before submit when the worktree already has a running loop', () => {
    mocks.state.loopsById = {
      'loop-0': { id: 'loop-0', worktreeId: 'wt-1', state: 'running' }
    }
    renderDialog()
    expect(screen.getByText(/already has a running loop/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start loop' })).toBeInTheDocument()
  })

  it('lists only detected agents', () => {
    mocks.detectedIds = ['claude']
    renderDialog()
    const options = screen.getAllByRole('combobox')[0].querySelectorAll('option')
    expect(Array.from(options, (option) => option.getAttribute('value'))).toEqual(['claude'])
  })

  it('explains why Start is disabled while the prompt is empty', () => {
    renderDialog()
    expect(screen.getByText('Enter a prompt to start the loop.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start loop' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    expect(screen.queryByText('Enter a prompt to start the loop.')).not.toBeInTheDocument()
  })

  it('defaults the interval anchor to from-end and sends wall-clock when chosen', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'On an interval' }))
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'poll' } })
    expect(selectWithOption('wall-clock')).toHaveValue('from-end')
    fireEvent.change(selectWithOption('wall-clock'), { target: { value: 'wall-clock' } })
    const input = await submittedInput()
    expect(input.config.pacing).toEqual({ kind: 'interval', minutes: 30, anchor: 'wall-clock' })
  })

  it('pre-fills the check timeout at 300 seconds and runs the check every iteration', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    enterCheckCommand()
    expect(screen.getByLabelText('Check timeout (seconds)')).toHaveValue('300')
    expect(selectWithOption('on-claim')).toHaveValue('every-iteration')
    const input = await submittedInput()
    expect(input.config.done.check).toEqual({
      command: 'pnpm test',
      timeoutSeconds: 300,
      runWhen: 'every-iteration'
    })
  })

  it('rejects a check timeout outside 1 to 600 seconds', () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    enterCheckCommand()
    const timeout = screen.getByLabelText('Check timeout (seconds)')
    const start = screen.getByRole('button', { name: 'Start loop' })
    for (const invalid of ['0', '601', '1.5', '']) {
      fireEvent.change(timeout, { target: { value: invalid } })
      expect(start).toBeDisabled()
    }
    expect(screen.getByText('Enter 1 to 600 seconds.')).toBeInTheDocument()
    for (const valid of ['1', '600']) {
      fireEvent.change(timeout, { target: { value: valid } })
      expect(start).toBeEnabled()
    }
  })

  it('sends on-claim when the check is set to run on a completion claim', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    enterCheckCommand()
    fireEvent.change(selectWithOption('on-claim'), { target: { value: 'on-claim' } })
    const input = await submittedInput()
    expect(input.config.done.check?.runWhen).toBe('on-claim')
  })

  it('omits the active-minutes cap until it is filled in and rejects bad values', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    openAdvanced()
    const minutes = screen.getByLabelText('Maximum active minutes')
    const start = screen.getByRole('button', { name: 'Start loop' })
    expect(minutes).toHaveValue('')
    expect(start).toBeEnabled()
    fireEvent.change(minutes, { target: { value: '0' } })
    expect(start).toBeDisabled()
    fireEvent.change(minutes, { target: { value: '90' } })
    const input = await submittedInput()
    expect(input.config.caps).toEqual({ maxIterations: 10, maxActiveMinutes: 90 })
  })
})
