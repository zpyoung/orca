// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunSnapshotWire } from '../../../../shared/pipeline-run-snapshot'
import type { PipelineRunSubscriptionError } from '@/runtime/pipeline-run-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const DEFAULT_TARGET: RuntimeClientTarget = { kind: 'local' }

let mockedHookResult: {
  snapshot: PipelineRunSnapshotWire | null
  runState: string | null
  isStale: boolean
  subscriptionError: PipelineRunSubscriptionError | null
  target: RuntimeClientTarget
} = {
  snapshot: null,
  runState: null,
  isStale: false,
  subscriptionError: null,
  target: DEFAULT_TARGET
}

vi.mock('./usePipelineRunSnapshot', () => ({
  usePipelineRunSnapshot: () => mockedHookResult
}))

const callRuntimeRpc = vi.fn<(..._args: unknown[]) => Promise<unknown>>(async () => ({
  state: 'ok'
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

import PipelineCanvas from './PipelineCanvas'

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
  mockedHookResult = {
    snapshot: null,
    runState: null,
    isStale: false,
    subscriptionError: null,
    target: DEFAULT_TARGET
  }
})

describe('PipelineCanvas', () => {
  it('shows a waiting placeholder before the first snapshot arrives', () => {
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText('run-1')).toBeInTheDocument()
  })

  it('shows an unsupported-host message instead of the blank loading placeholder', () => {
    mockedHookResult = {
      snapshot: null,
      runState: null,
      isStale: false,
      subscriptionError: { kind: 'unsupported', message: 'Unknown method: pipeline.subscribe' },
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/does not support pipelines/i)).toBeInTheDocument()
    expect(screen.queryByText(/could not reach/i)).not.toBeInTheDocument()
  })

  it('shows a distinct transient-error message before any snapshot has arrived', () => {
    mockedHookResult = {
      snapshot: null,
      runState: null,
      isStale: false,
      subscriptionError: { kind: 'transient', message: 'socket closed' },
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/could not reach/i)).toBeInTheDocument()
    expect(screen.queryByText(/does not support pipelines/i)).not.toBeInTheDocument()
  })

  it('keeps rendering the run once a snapshot exists even if a later subscription error occurs', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', templateName: 'bugfix-fast', runNumber: 4, state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: { kind: 'transient', message: 'socket closed' },
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/bugfix-fast/)).toBeInTheDocument()
    expect(screen.getByText(/could not reach/i)).toBeInTheDocument()
  })

  it('shows the template name, run number, and run state once a snapshot arrives', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', templateName: 'bugfix-fast', runNumber: 4, state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/bugfix-fast/)).toBeInTheDocument()
    expect(screen.getByText(/#4/)).toBeInTheDocument()
    expect(screen.getByText(/running/i)).toBeInTheDocument()
  })

  it('shows the needs-a-newer-Orca banner when the snapshot flags needsNewerOrca', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', needsNewerOrca: true, state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/may need a newer Orca/i)).toBeInTheDocument()
  })

  it('omits the needs-a-newer-Orca banner when the flag is not set', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', needsNewerOrca: false, state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText(/may need a newer Orca/i)).not.toBeInTheDocument()
  })

  it('shows a staleness indicator when the hook reports stale', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() },
      runState: 'running',
      isStale: true,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/last confirmed/i)).toBeInTheDocument()
  })

  it('omits the staleness indicator when not stale', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText(/last confirmed/i)).not.toBeInTheDocument()
  })

  it('renders the scene nodes from the snapshot', () => {
    mockedHookResult = {
      snapshot: {
        runId: 'run-1',
        state: 'running',
        nodes: [
          { id: 'repro', title: 'Reproduce', status: 'succeeded' },
          { id: 'fix', title: 'Fix', status: 'running' }
        ]
      },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText('Reproduce')).toBeInTheDocument()
    expect(screen.getByText('Fix')).toBeInTheDocument()
  })

  it('shows elapsed time on a running node, derived from host clocks rather than the raw local clock', () => {
    const publishedAt = new Date().toISOString()
    const startedAt = new Date(Date.parse(publishedAt) - 65_000).toISOString()
    mockedHookResult = {
      snapshot: {
        runId: 'run-1',
        state: 'running',
        publishedAt,
        nodes: [{ id: 'fix', title: 'Fix', status: 'running', startedAt }]
      },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/^1m 0[0-9]s$/)).toBeInTheDocument()
  })

  it('shows no elapsed time for a running node with no startedAt on the wire', () => {
    mockedHookResult = {
      snapshot: {
        runId: 'run-1',
        state: 'running',
        publishedAt: new Date().toISOString(),
        nodes: [{ id: 'fix', title: 'Fix', status: 'running' }]
      },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText(/^\d+(m \d+)?s$/)).not.toBeInTheDocument()
  })

  it('shows run controls for a live run', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument()
  })

  it('shows no run controls once the run is terminal', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'completed' },
      runState: 'completed',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByRole('button', { name: /pause/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /abort/i })).not.toBeInTheDocument()
  })

  it("sends Pause to the run's own resolved target, not some other host", async () => {
    const runOwnerTarget: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-owner' }
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: runOwnerTarget
    }
    const user = userEvent.setup()
    render(<PipelineCanvas runId="run-1" />)
    await user.click(screen.getByRole('button', { name: /pause/i }))
    expect(callRuntimeRpc).toHaveBeenCalledWith(runOwnerTarget, 'pipeline.pause', { runId: 'run-1' })
    expect(callRuntimeRpc).not.toHaveBeenCalledWith(DEFAULT_TARGET, 'pipeline.pause', {
      runId: 'run-1'
    })
  })

  it('shows the persisted failure reason for a failed run', () => {
    mockedHookResult = {
      snapshot: {
        runId: 'run-1',
        state: 'failed',
        failureReason: 'setup refused: harness disabled for node "repro"'
      },
      runState: 'failed',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(
      screen.getByText('setup refused: harness disabled for node "repro"')
    ).toBeInTheDocument()
  })

  it('omits the failure reason banner for a non-failed run even if one is present on the wire', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running', failureReason: 'stale from a prior attempt' },
      runState: 'running',
      isStale: false,
      subscriptionError: null,
      target: DEFAULT_TARGET
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText('stale from a prior attempt')).not.toBeInTheDocument()
  })
})
