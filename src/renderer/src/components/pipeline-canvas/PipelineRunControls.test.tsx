// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.fn(async (..._args: unknown[]) => ({ state: 'ok' }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import PipelineRunControls from './PipelineRunControls'

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
})

const target = { kind: 'local' as const }

describe('PipelineRunControls', () => {
  it('shows Pause and Abort for a running run, not Resume', () => {
    render(<PipelineRunControls runId="run-1" runState="running" target={target} />)
    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /abort/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument()
  })

  it('shows Resume and Abort for a paused run, not Pause', () => {
    render(<PipelineRunControls runId="run-1" runState="paused" target={target} />)
    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /abort/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^pause$/i })).not.toBeInTheDocument()
  })

  it('renders no controls for a terminal run', () => {
    render(<PipelineRunControls runId="run-1" runState="completed" target={target} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders no controls while the run state is unknown', () => {
    render(<PipelineRunControls runId="run-1" runState={null} target={target} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls pipeline.pause with the run id when Pause is clicked', async () => {
    const user = userEvent.setup()
    render(<PipelineRunControls runId="run-1" runState="running" target={target} />)
    await user.click(screen.getByRole('button', { name: /pause/i }))
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'pipeline.pause', { runId: 'run-1' })
  })

  it('calls pipeline.resume with the run id when Resume is clicked', async () => {
    const user = userEvent.setup()
    render(<PipelineRunControls runId="run-1" runState="paused" target={target} />)
    await user.click(screen.getByRole('button', { name: /resume/i }))
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'pipeline.resume', { runId: 'run-1' })
  })

  it('does not call pipeline.abort until the confirm dialog is accepted', async () => {
    const user = userEvent.setup()
    render(<PipelineRunControls runId="run-1" runState="running" target={target} />)
    await user.click(screen.getByRole('button', { name: /abort/i }))
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    const confirmButton = screen.getByRole('button', { name: /^abort run$/i })
    await user.click(confirmButton)
    expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'pipeline.abort', { runId: 'run-1' })
  })

  it('calls nothing when the abort confirm dialog is cancelled', async () => {
    const user = userEvent.setup()
    render(<PipelineRunControls runId="run-1" runState="running" target={target} />)
    await user.click(screen.getByRole('button', { name: /abort/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})
