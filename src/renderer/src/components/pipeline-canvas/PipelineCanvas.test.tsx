// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRunSnapshotWire } from '../../../../shared/pipeline-run-snapshot'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: { activeRuntimeEnvironmentId: null } })
}))

let mockedHookResult: {
  snapshot: PipelineRunSnapshotWire | null
  runState: string | null
  isStale: boolean
} = { snapshot: null, runState: null, isStale: false }

vi.mock('./usePipelineRunSnapshot', () => ({
  usePipelineRunSnapshot: () => mockedHookResult
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ state: 'ok' })),
  getActiveRuntimeTarget: () => ({ kind: 'local' as const })
}))

import PipelineCanvas from './PipelineCanvas'

afterEach(() => {
  cleanup()
  mockedHookResult = { snapshot: null, runState: null, isStale: false }
})

describe('PipelineCanvas', () => {
  it('shows a waiting placeholder before the first snapshot arrives', () => {
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText('run-1')).toBeInTheDocument()
  })

  it('shows the template name, run number, and run state once a snapshot arrives', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', templateName: 'bugfix-fast', runNumber: 4, state: 'running' },
      runState: 'running',
      isStale: false
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
      isStale: false
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/may need a newer Orca/i)).toBeInTheDocument()
  })

  it('omits the needs-a-newer-Orca banner when the flag is not set', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', needsNewerOrca: false, state: 'running' },
      runState: 'running',
      isStale: false
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText(/may need a newer Orca/i)).not.toBeInTheDocument()
  })

  it('shows a staleness indicator when the hook reports stale', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() },
      runState: 'running',
      isStale: true
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByText(/last confirmed/i)).toBeInTheDocument()
  })

  it('omits the staleness indicator when not stale', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running', publishedAt: new Date().toISOString() },
      runState: 'running',
      isStale: false
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
      isStale: false
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
      isStale: false
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
      isStale: false
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByText(/^\d+(m \d+)?s$/)).not.toBeInTheDocument()
  })

  it('shows run controls for a live run', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'running' },
      runState: 'running',
      isStale: false
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument()
  })

  it('shows no run controls once the run is terminal', () => {
    mockedHookResult = {
      snapshot: { runId: 'run-1', state: 'completed' },
      runState: 'completed',
      isStale: false
    }
    render(<PipelineCanvas runId="run-1" />)
    expect(screen.queryByRole('button', { name: /pause/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /abort/i })).not.toBeInTheDocument()
  })
})
