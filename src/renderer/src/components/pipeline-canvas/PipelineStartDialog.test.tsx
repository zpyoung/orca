// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type * as EnsurePipelineTabModule from '@/lib/ensure-pipeline-tab'

type TestTemplateEntry = {
  basename: string
  name: string
  description?: string
  needsNewerOrca: boolean
}

type TestPipelineStartResult =
  | { runId: string; runNumber: number; branch?: string }
  | { refused: { nodeId?: string; field?: string; message: string } }

type TestRunListEntry = {
  runId: string
  templateName: string
  runNumber: number
  state: string
  workspaceDisplayName: string
  workspaceId?: string
}

let listRunsResult: TestRunListEntry[] = []
let startResult: TestPipelineStartResult = { runId: 'run-1', runNumber: 1 }

const callRuntimeRpc = vi.fn<(..._args: unknown[]) => Promise<unknown>>(
  async (_target, method, params) => {
    if (method === 'pipeline.listRuns') {
      // mirrors the host: a workspaceId filter excludes rows whose own workspaceId
      // doesn't match — including deleted-workspace rows, which carry none at all.
      const workspaceId = (params as { workspaceId?: string } | undefined)?.workspaceId
      const runs = workspaceId
        ? listRunsResult.filter((run) => run.workspaceId === workspaceId)
        : listRunsResult
      return { runs }
    }
    return startResult
  }
)
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

const ensurePipelineTab = vi.fn<(..._args: unknown[]) => string | null>(() => 'tab-1')
vi.mock('@/lib/ensure-pipeline-tab', async (importOriginal) => {
  // canEnsurePipelineTab stays real (reads the real store, seeded per-test via
  // seedLiveWorkspace) — only tab creation itself is faked.
  const actual = await importOriginal<typeof EnsurePipelineTabModule>()
  return {
    ...actual,
    ensurePipelineTab: (...args: unknown[]) => ensurePipelineTab(...args)
  }
})

type TestResolveResult =
  | {
      ok: true
      definition: {
        templateName: string
        templateVersion: number
        needsNewerOrca: boolean
        inputText: string
        nodes: unknown[]
      }
    }
  | {
      ok: false
      error:
        | { kind: 'template_error'; detail: { rule: number; nodeId?: string; field?: string; message: string } }
        | { kind: 'template_not_found' }
        | { kind: 'invalid_basename' }
    }

const listTemplates = vi.fn<() => Promise<TestTemplateEntry[]>>()
const resolveTemplate = vi.fn<() => Promise<TestResolveResult>>(async () => ({
  ok: true,
  definition: {
    templateName: 'bugfix-fast',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'repro',
    nodes: []
  }
}))

import PipelineStartDialog from './PipelineStartDialog'

function setup(templates: TestTemplateEntry[]): void {
  listTemplates.mockResolvedValue(templates)
  ;(window as unknown as { api: unknown }).api = {
    pipelines: { listTemplates, resolveTemplate }
  }
}

const target = { kind: 'local' as const }

/** Seeds a tab group for `worktreeId` so canEnsurePipelineTab treats it as a live workspace. */
function seedLiveWorkspace(worktreeId: string): void {
  useAppStore.setState({
    groupsByWorktree: {
      ...useAppStore.getState().groupsByWorktree,
      [worktreeId]: [{ id: `${worktreeId}-group`, worktreeId, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: {
      ...useAppStore.getState().activeGroupIdByWorktree,
      [worktreeId]: `${worktreeId}-group`
    }
  })
}

beforeEach(() => {
  // default to no live workspaces — each test opts a workspace in via seedLiveWorkspace
  useAppStore.setState({ groupsByWorktree: {}, activeGroupIdByWorktree: {} })
})

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
  resolveTemplate.mockClear()
  listTemplates.mockClear()
  ensurePipelineTab.mockClear()
  listRunsResult = []
  startResult = { runId: 'run-1', runNumber: 1 }
})

describe('PipelineStartDialog', () => {
  it('lists templates with their name and description', async () => {
    setup([
      {
        basename: 'bugfix-fast.yaml',
        name: 'bugfix-fast',
        description: 'Fix a bug',
        needsNewerOrca: false
      }
    ])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.getByText('Fix a bug')).toBeInTheDocument()
  })

  it('shows the needs-a-newer-Orca sentence only for a flagged template', async () => {
    setup([
      { basename: 'a.yaml', name: 'flagged', needsNewerOrca: true },
      { basename: 'b.yaml', name: 'plain', needsNewerOrca: false }
    ])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('flagged')).toBeInTheDocument())
    const sentences = screen.getAllByText(/may need a newer Orca/i)
    expect(sentences).toHaveLength(1)
  })

  it('shows the folder-workspace forward-only warning for a folder workspace', async () => {
    setup([{ basename: 'a.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={true}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.getByText(/forward-only/i)).toBeInTheDocument()
  })

  it('omits the folder-workspace warning for a git workspace', async () => {
    setup([{ basename: 'a.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.queryByText(/forward-only/i)).not.toBeInTheDocument()
  })

  it('shows the submodule caveat when hasSubmodules is set', async () => {
    setup([{ basename: 'a.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={true}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.getByText(/submodule/i)).toBeInTheDocument()
  })

  // Regression (R11): the copy must stay true whether or not this repository actually
  // has submodules — a general "if this repo has any" caveat, never an assertion that it does.
  it('phrases the submodule caveat as conditional, not as a claim about this repository', async () => {
    setup([{ basename: 'a.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={true}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.getByText(/if this repository has any/i)).toBeInTheDocument()
    expect(screen.queryByText(/this repository has submodules/i)).not.toBeInTheDocument()
  })

  it('resolves the selected template and starts the run on submit', async () => {
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    const onStarted = vi.fn()
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
        onStarted={onStarted}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    await user.click(screen.getByText('bugfix-fast'))
    await user.type(screen.getByRole('textbox', { name: /input/i }), 'Login button is broken')

    await user.click(screen.getByRole('button', { name: /^start$/i }))

    await waitFor(() =>
      expect(resolveTemplate).toHaveBeenCalledWith({
        basename: 'bugfix-fast.yaml',
        inputText: 'Login button is broken'
      })
    )
    await waitFor(() =>
      expect(callRuntimeRpc).toHaveBeenCalledWith(
        target,
        'pipeline.start',
        expect.objectContaining({ worktree: 'id:w1' })
      )
    )
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith({
        runId: 'run-1',
        runNumber: 1,
        templateName: 'bugfix-fast'
      })
    )
  })

  it('shows the structural-rejection message naming the offending node and never starts the run (AC14)', async () => {
    setup([{ basename: 'broken.yaml', name: 'broken', needsNewerOrca: false }])
    resolveTemplate.mockResolvedValueOnce({
      ok: false as const,
      error: {
        kind: 'template_error' as const,
        detail: {
          rule: 8,
          nodeId: 'b',
          field: 'needs',
          message: 'Node "b" needs an unknown node id "nonexistent".'
        }
      }
    })
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('broken')).toBeInTheDocument())
    await user.click(screen.getByText('broken'))
    await user.type(screen.getByRole('textbox', { name: /input/i }), 'x')
    await user.click(screen.getByRole('button', { name: /^start$/i }))

    await waitFor(() =>
      expect(screen.getByText('Node "b" needs an unknown node id "nonexistent".')).toBeInTheDocument()
    )
    expect(callRuntimeRpc).not.toHaveBeenCalledWith(target, 'pipeline.start', expect.anything())
  })

  it('shows the refusal message instead of starting when the host refuses', async () => {
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    startResult = { refused: { nodeId: 'repro', field: 'harness', message: 'Agent disabled' } }
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    await user.click(screen.getByText('bugfix-fast'))
    await user.type(screen.getByRole('textbox', { name: /input/i }), 'x')
    await user.click(screen.getByRole('button', { name: /^start$/i }))

    await waitFor(() => expect(screen.getByText('Agent disabled')).toBeInTheDocument())
  })

  it('shows prior runs with their template name, workspace, run number, and state', async () => {
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'nightly-refactor',
        runNumber: 3,
        state: 'completed',
        workspaceDisplayName: 'orca'
      }
    ]
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() =>
      expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'pipeline.listRuns', expect.any(Object))
    )
    // the run's own template name (nightly-refactor) must be distinguishable from the
    // picker's bugfix-fast, so a run isn't identifiable only by its workspace and number
    await waitFor(() => expect(screen.getByText(/nightly-refactor/)).toBeInTheDocument())
    expect(screen.getByText(/orca #3/)).toBeInTheDocument()
    expect(screen.getByText(/completed/i)).toBeInTheDocument()
  })

  it('reopens a history run at its own workspace when clicked', async () => {
    seedLiveWorkspace('w9')
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'bugfix-fast',
        runNumber: 3,
        state: 'running',
        workspaceDisplayName: 'orca',
        workspaceId: 'w9'
      }
    ]
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={onOpenChange}
        worktreeSelector="id:w1"
        workspaceId="w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText(/orca #3/)).toBeInTheDocument())
    await user.click(screen.getByText(/orca #3/))

    expect(ensurePipelineTab).toHaveBeenCalledWith('w9', {
      runId: 'run-9',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open and reports failure when a live-workspace row cannot be surfaced', async () => {
    seedLiveWorkspace('w9')
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'bugfix-fast',
        runNumber: 3,
        state: 'running',
        workspaceDisplayName: 'orca',
        workspaceId: 'w9'
      }
    ]
    // canEnsurePipelineTab's render-time gate can go stale by the time of the click
    // (e.g. an SSH host disconnects) — ensurePipelineTab reports that failure by
    // returning null.
    ensurePipelineTab.mockReturnValueOnce(null)
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    const onOpenChange = vi.fn()
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={onOpenChange}
        worktreeSelector="id:w1"
        workspaceId="w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText(/orca #3/)).toBeInTheDocument())
    await user.click(screen.getByText(/orca #3/))

    expect(ensurePipelineTab).toHaveBeenCalledWith('w9', {
      runId: 'run-9',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByText(/couldn't open that run's workspace/i)).toBeInTheDocument()
    )
  })

  it("falls back to the dialog's own scoping workspace when a history row carries none", async () => {
    seedLiveWorkspace('w1')
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'bugfix-fast',
        runNumber: 3,
        state: 'running',
        workspaceDisplayName: 'orca'
      }
    ]
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    const user = userEvent.setup()
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        workspaceId="w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText(/orca #3/)).toBeInTheDocument())
    await user.click(screen.getByText(/orca #3/))

    expect(ensurePipelineTab).toHaveBeenCalledWith('w1', {
      runId: 'run-9',
      runNumber: 3,
      templateName: 'bugfix-fast'
    })
  })

  it('leaves a history row inert when no workspace is known for it', async () => {
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'bugfix-fast',
        runNumber: 3,
        state: 'running',
        workspaceDisplayName: 'orca'
      }
    ]
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText(/orca #3/)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /orca #3/ })).not.toBeInTheDocument()
  })

  it('presents a run-history row as non-actionable, not hidden, once its owning workspace is removed via the real store purge path', async () => {
    seedLiveWorkspace('w1')
    seedLiveWorkspace('w-removed')
    // drive the same removal path a host worktree-deletion event triggers (see
    // purgeWorktreeTerminalState), instead of simply never seeding the workspace —
    // so the row's non-live classification traces to real removal, not a fixture
    // that merely looks like one.
    useAppStore.getState().purgeWorktreeTerminalState(['w-removed'])
    listRunsResult = [
      {
        runId: 'run-live',
        templateName: 'bugfix-fast',
        runNumber: 1,
        state: 'running',
        workspaceDisplayName: 'orca',
        workspaceId: 'w1'
      },
      {
        runId: 'run-removed-workspace',
        templateName: 'bugfix-fast',
        runNumber: 2,
        state: 'completed',
        workspaceDisplayName: 'old-workspace',
        workspaceId: 'w-removed'
      }
    ]
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        workspaceId="w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )

    await waitFor(() => expect(screen.getByText(/orca #1/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /orca #1/ })).toBeInTheDocument()

    expect(screen.getByText(/old-workspace #2/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /old-workspace #2/ })).not.toBeInTheDocument()
    expect(screen.getByText(/workspace deleted/i)).toBeInTheDocument()
  })

  it('shows no history section when there are no prior runs', async () => {
    listRunsResult = []
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.queryByRole('region', { name: /recent runs/i })).not.toBeInTheDocument()
  })

  it('disables Start until a template is selected and input text is entered', async () => {
    setup([{ basename: 'bugfix-fast.yaml', name: 'bugfix-fast', needsNewerOrca: false }])
    render(
      <PipelineStartDialog
        open={true}
        onOpenChange={() => {}}
        worktreeSelector="id:w1"
        target={target}
        isFolderWorkspace={false}
        hasSubmodules={false}
      />
    )
    await waitFor(() => expect(screen.getByText('bugfix-fast')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^start$/i })).toBeDisabled()
  })
})
