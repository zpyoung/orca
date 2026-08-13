// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { RunPipelineMenuItem } from './RunPipelineMenuItem'

// A real controlled menu, not a fixed `open` prop — Radix closes (and unmounts
// DropdownMenuContent) on select unless the item's onSelect prevents it, and only
// a genuinely stateful root reproduces that so the test can catch a regression.
function ControlledMenu({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuContent>
        <RunPipelineMenuItem worktreeId={worktreeId} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type TestPipelineStartResult =
  | { runId: string; runNumber: number; branch?: string }
  | { refused: { nodeId?: string; field?: string; message: string } }

let startResult: TestPipelineStartResult = { runId: 'run-1', runNumber: 5 }

const callRuntimeRpc = vi.fn<(..._args: unknown[]) => Promise<unknown>>(async (_target, method) => {
  if (method === 'pipeline.listRuns') {
    return { runs: [] }
  }
  return startResult
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

const listTemplates = vi.fn(async () => [
  { basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }
])
const resolveTemplate = vi.fn(async () => ({
  ok: true as const,
  definition: {
    templateName: 'bugfix-fast',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'repro',
    nodes: []
  }
}))

function renderMenu(worktreeId: string): void {
  render(<ControlledMenu worktreeId={worktreeId} />)
}

async function submitFirstTemplate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByText(/run pipeline/i))
  await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
  await user.click(screen.getByText('bugfix-fast'))
  await user.type(screen.getByRole('textbox', { name: /input/i }), 'fix the login button')
  await user.click(screen.getByRole('button', { name: /^start$/i }))
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    pipelines: { listTemplates, resolveTemplate }
  }
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
    },
    unifiedTabsByWorktree: { 'wt-1': [] }
  })
})

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
  resolveTemplate.mockClear()
  listTemplates.mockClear()
  startResult = { runId: 'run-1', runNumber: 5 }
})

describe('RunPipelineMenuItem', () => {
  it('opens the pipeline start dialog when selected', async () => {
    renderMenu('wt-1')
    const user = userEvent.setup()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByText(/run pipeline/i))

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
  })

  it('creates and surfaces a pipeline tab keyed by the run id on a successful start', async () => {
    startResult = { runId: 'run-42', runNumber: 7 }
    renderMenu('wt-1')
    const user = userEvent.setup()

    await submitFirstTemplate(user)

    await waitFor(() => {
      const tabs = useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
      const tab = tabs.find((candidate) => candidate.entityId === 'run-42')
      expect(tab).toBeDefined()
      expect(tab?.contentType).toBe('pipeline')
      expect(tab?.label).toBe('bugfix-fast #7')
    })
  })

  it('reuses the tab for a run that was already surfaced instead of duplicating it', async () => {
    startResult = { runId: 'run-42', runNumber: 7 }
    renderMenu('wt-1')
    const user = userEvent.setup()
    await submitFirstTemplate(user)
    await waitFor(() =>
      expect(
        (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).some(
          (candidate) => candidate.entityId === 'run-42'
        )
      ).toBe(true)
    )

    await submitFirstTemplate(user)

    await waitFor(() => {
      const tabs = useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
      expect(tabs.filter((candidate) => candidate.entityId === 'run-42')).toHaveLength(1)
    })
  })

  it('surfaces the refusal message instead of creating a tab', async () => {
    startResult = { refused: { nodeId: 'repro', field: 'harness', message: 'Agent disabled' } }
    renderMenu('wt-1')
    const user = userEvent.setup()

    await submitFirstTemplate(user)

    await waitFor(() => expect(screen.getByText('Agent disabled')).toBeInTheDocument())
    expect(useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).toHaveLength(0)
  })
})
