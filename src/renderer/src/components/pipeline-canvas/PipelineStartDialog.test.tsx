// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
}

let listRunsResult: TestRunListEntry[] = []
let startResult: TestPipelineStartResult = { runId: 'run-1', runNumber: 1 }

const callRuntimeRpc = vi.fn<(..._args: unknown[]) => Promise<unknown>>(async (_target, method) => {
  if (method === 'pipeline.listRuns') {
    return { runs: listRunsResult }
  }
  return startResult
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))

const listTemplates = vi.fn<() => Promise<TestTemplateEntry[]>>()
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

import PipelineStartDialog from './PipelineStartDialog'

function setup(templates: TestTemplateEntry[]): void {
  listTemplates.mockResolvedValue(templates)
  ;(window as unknown as { api: unknown }).api = {
    pipelines: { listTemplates, resolveTemplate }
  }
}

const target = { kind: 'local' as const }

afterEach(() => {
  cleanup()
  callRuntimeRpc.mockClear()
  resolveTemplate.mockClear()
  listTemplates.mockClear()
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

  it('shows the submodule warning when the workspace has submodules', async () => {
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

  it('shows prior runs with their workspace, run number, and state', async () => {
    listRunsResult = [
      {
        runId: 'run-9',
        templateName: 'bugfix-fast',
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
    await waitFor(() => expect(screen.getByText(/orca #3/)).toBeInTheDocument())
    expect(screen.getByText(/completed/i)).toBeInTheDocument()
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
