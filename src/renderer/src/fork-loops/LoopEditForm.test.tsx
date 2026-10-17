// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LoopEditPatchSchema,
  type LoopConfig,
  type LoopSnapshot
} from '../../../shared/fork-loops/loop-types'
import { LoopEditForm } from './LoopEditForm'

type MockRepo = { id: string; kind?: 'git' | 'folder' }

const mocks = vi.hoisted(() => {
  const repos: MockRepo[] = []
  return { state: { repos } }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

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

const BASE_CONFIG: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'keep going' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: { maxIterations: 10 },
  noProgress: true,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

function makeLoop(config: Partial<LoopConfig> = {}, overrides: Partial<LoopSnapshot> = {}) {
  const loop: LoopSnapshot = {
    id: 'loop-1',
    worktreeId: 'wt-1',
    name: 'Fix the flaky tests',
    agent: 'claude',
    preset: 'until-done',
    config: { ...BASE_CONFIG, ...config },
    state: 'running',
    iterationsCompleted: 4,
    detached: false,
    skippedTicks: 0,
    activeMs: 0,
    recentIterations: [],
    ...overrides
  }
  return loop
}

function renderForm(loop: LoopSnapshot): ReturnType<typeof vi.fn> {
  const onSave = vi.fn()
  render(<LoopEditForm loop={loop} busy={false} onSave={onSave} onCancel={vi.fn()} />)
  return onSave
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

function openAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

function savedPatch(onSave: ReturnType<typeof vi.fn>): unknown {
  expect(onSave).toHaveBeenCalledTimes(1)
  const patch = onSave.mock.calls[0][0]
  expect(LoopEditPatchSchema.safeParse(patch).success).toBe(true)
  return patch
}

beforeEach(() => {
  mocks.state.repos = []
})

afterEach(cleanup)

describe('LoopEditForm', () => {
  it('pre-fills every editable setting from the loop', () => {
    renderForm(
      makeLoop({
        promptSource: { kind: 'repeat', body: 'poll the queue' },
        pacing: { kind: 'interval', minutes: 15, anchor: 'wall-clock' },
        sessionPolicy: 'continue',
        done: {
          check: { command: 'pnpm test', timeoutSeconds: 120, runWhen: 'on-claim' },
          evaluator: { condition: 'all tests pass' }
        },
        caps: { maxIterations: 7, maxActiveMinutes: 90 },
        protectedPaths: ['src/a.ts', 'dist/**'],
        noProgress: false,
        askBeforeNext: true
      })
    )

    expect(screen.getByLabelText('Name')).toHaveValue('Fix the flaky tests')
    expect(screen.getByLabelText('Prompt')).toHaveValue('poll the queue')
    expect(selectWithOption('interval')).toHaveValue('interval')
    expect(screen.getByLabelText('Run every (minutes)')).toHaveValue('15')
    expect(selectWithOption('wall-clock')).toHaveValue('wall-clock')
    expect(selectWithOption('continue')).toHaveValue('continue')
    expect(screen.getByLabelText('Maximum iterations')).toHaveValue('7')
    openAdvanced()
    expect(screen.getByLabelText('Done check command')).toHaveValue('pnpm test')
    expect(screen.getByLabelText('Check timeout (seconds)')).toHaveValue('120')
    expect(selectWithOption('on-claim')).toHaveValue('on-claim')
    expect(screen.getByLabelText('Done condition')).toHaveValue('all tests pass')
    expect(screen.getByLabelText('Maximum active minutes')).toHaveValue('90')
    expect(screen.getByLabelText('Protected paths')).toHaveValue('src/a.ts\ndist/**')
    expect(
      screen.getByRole('checkbox', { name: 'Pause after 3 iterations with no changes' })
    ).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Ask before each new iteration' })).toBeChecked()
  })

  it('disables Save until something changes', () => {
    renderForm(makeLoop())
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'try again' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('submits only the prompt when only the prompt changed', () => {
    const onSave = renderForm(makeLoop())
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  try again  ' } })
    save()

    expect(savedPatch(onSave)).toEqual({ promptSource: { kind: 'repeat', body: 'try again' } })
  })

  it('submits a rename on its own', () => {
    const onSave = renderForm(makeLoop())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Renamed ' } })
    save()

    expect(savedPatch(onSave)).toEqual({ name: 'Renamed' })
  })

  it('switches pacing from on-idle to an interval with an anchor', () => {
    const onSave = renderForm(makeLoop())
    expect(screen.queryByLabelText('Run every (minutes)')).not.toBeInTheDocument()
    fireEvent.change(selectWithOption('interval'), { target: { value: 'interval' } })
    fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '20' } })
    fireEvent.change(selectWithOption('wall-clock'), { target: { value: 'wall-clock' } })
    save()

    expect(savedPatch(onSave)).toEqual({
      pacing: { kind: 'interval', minutes: 20, anchor: 'wall-clock' }
    })
  })

  it('blocks Save when the interval is below 1', () => {
    const onSave = renderForm(
      makeLoop({ pacing: { kind: 'interval', minutes: 15, anchor: 'from-end' } })
    )
    fireEvent.change(screen.getByLabelText('Run every (minutes)'), { target: { value: '0' } })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Enter a whole number of at least 1.')).toBeInTheDocument()
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('submits the session policy', () => {
    const onSave = renderForm(makeLoop())
    fireEvent.change(selectWithOption('continue'), { target: { value: 'continue' } })
    save()

    expect(savedPatch(onSave)).toEqual({ sessionPolicy: 'continue' })
  })

  it('submits the done signal as a whole when the check or condition changes', () => {
    const onSave = renderForm(makeLoop())
    openAdvanced()
    fireEvent.change(screen.getByLabelText('Done check command'), {
      target: { value: 'pnpm test' }
    })
    fireEvent.change(screen.getByLabelText('Check timeout (seconds)'), { target: { value: '60' } })
    fireEvent.change(selectWithOption('on-claim'), { target: { value: 'on-claim' } })
    fireEvent.change(screen.getByLabelText('Done condition'), { target: { value: 'it works' } })
    save()

    expect(savedPatch(onSave)).toEqual({
      done: {
        check: { command: 'pnpm test', timeoutSeconds: 60, runWhen: 'on-claim' },
        evaluator: { condition: 'it works' }
      }
    })
  })

  it('clears the done signal when the check command is emptied', () => {
    const onSave = renderForm(
      makeLoop({
        done: { check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' } }
      })
    )
    openAdvanced()
    fireEvent.change(screen.getByLabelText('Done check command'), { target: { value: '' } })
    save()

    expect(savedPatch(onSave)).toEqual({ done: {} })
  })

  it('rejects a check timeout outside 1 to 600 seconds', () => {
    renderForm(
      makeLoop({
        done: { check: { command: 'pnpm test', timeoutSeconds: 300, runWhen: 'every-iteration' } }
      })
    )
    openAdvanced()
    fireEvent.change(screen.getByLabelText('Check timeout (seconds)'), { target: { value: '601' } })

    expect(screen.getByText('Enter 1 to 600 seconds.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('submits caps, protected paths, and the option flags', () => {
    const onSave = renderForm(makeLoop({}, { costUsd: 0.5 }))
    fireEvent.change(screen.getByLabelText('Maximum iterations'), { target: { value: '' } })
    openAdvanced()
    fireEvent.change(screen.getByLabelText('Maximum active minutes'), { target: { value: '45' } })
    fireEvent.change(screen.getByLabelText('Maximum cost (USD)'), { target: { value: '2.5' } })
    fireEvent.change(screen.getByLabelText('Protected paths'), {
      target: { value: 'src/a.ts\n\n  dist/**  ' }
    })
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Commit a checkpoint after each iteration' })
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ask before each new iteration' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Resume when the usage limit resets' }))
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Pause after 3 iterations with no changes' })
    )
    save()

    expect(savedPatch(onSave)).toEqual({
      caps: { maxActiveMinutes: 45, maxCostUsd: 2.5 },
      protectedPaths: ['src/a.ts', 'dist/**'],
      noProgress: false,
      checkpointCommits: true,
      askBeforeNext: true,
      resumeAtLimitReset: true
    })
  })

  it('empties the protected paths when the field is cleared', () => {
    const onSave = renderForm(makeLoop({ protectedPaths: ['src/a.ts'] }))
    openAdvanced()
    fireEvent.change(screen.getByLabelText('Protected paths'), { target: { value: '' } })
    save()

    expect(savedPatch(onSave)).toEqual({ protectedPaths: [] })
  })

  it('hides the cost cap until the loop reports cost or has one', () => {
    renderForm(makeLoop())
    openAdvanced()
    expect(screen.queryByLabelText('Maximum cost (USD)')).not.toBeInTheDocument()
  })

  it('hides checkpoint commits in a folder workspace', () => {
    mocks.state.repos = [{ id: 'wt-1', kind: 'folder' }]
    renderForm(makeLoop())
    openAdvanced()
    expect(
      screen.queryByRole('checkbox', { name: 'Commit a checkpoint after each iteration' })
    ).not.toBeInTheDocument()
  })

  it('blocks Save on a blank prompt or name', () => {
    renderForm(makeLoop())
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  ' } })
    expect(screen.getByText('Enter a prompt.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'go' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } })
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('edits a queue loop without a prompt box and keeps the queue untouched', () => {
    const onSave = renderForm(
      makeLoop({ promptSource: { kind: 'queue', repeatQueue: false } }, { preset: 'queue' })
    )
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Start over when the queue is empty' }))
    save()

    expect(savedPatch(onSave)).toEqual({ promptSource: { kind: 'queue', repeatQueue: true } })
  })
})
