// @vitest-environment happy-dom
import { createElement, Fragment, type ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type * as PipelineFileIo from './pipeline-file-io'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { PipelineCanvas } from './PipelineCanvas'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import {
  installCanvasRunApi,
  pinnedRunView,
  pipelineRunRow,
  repoPipelineId,
  runCanvasDocument,
  worktreeId
} from './pipeline-canvas-run-fixtures'

const pipelineMocks = vi.hoisted(() => ({
  readRepoPipeline: vi.fn(),
  watchRepoPipeline: vi.fn(() => () => undefined),
  listRepoPipelineIds: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(() => true)
}))

// The flow renderer needs a DOM shim, so this test renders production node views inside the mocked graph surface.
vi.mock('@xyflow/react', () => {
  type FlowNode = { id: string; type: string; data: { node: unknown }; selected: boolean }
  type NodeViewProps = { id: string; type: string; data: { node: unknown }; selected: boolean }
  type NodeView = (props: NodeViewProps) => ReactNode
  type FlowProps = {
    nodes: FlowNode[]
    nodeTypes: Record<string, NodeView>
    onNodeClick?: (event: unknown, node: FlowNode) => void
    children?: ReactNode
    'aria-label'?: string
  }

  const ReactFlow = ({ nodes, nodeTypes, onNodeClick, children, 'aria-label': label }: FlowProps) =>
    createElement(
      'div',
      { role: 'application', 'aria-label': label },
      ...nodes.map((node) => {
        const NodeRenderer = nodeTypes[node.type]
        return createElement(
          'button',
          {
            key: node.id,
            type: 'button',
            'aria-label': `Select node ${node.id}`,
            'aria-pressed': node.selected,
            onClick: (event: unknown) => onNodeClick?.(event, node)
          },
          createElement(NodeRenderer, {
            id: node.id,
            type: node.type,
            data: node.data,
            selected: node.selected
          })
        )
      }),
      children
    )

  return {
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: ReactNode }) =>
      createElement(Fragment, null, children),
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y })
    })
  }
})

vi.mock('./pipeline-file-io', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineFileIo>()
  return {
    ...actual,
    readRepoPipeline: pipelineMocks.readRepoPipeline,
    watchRepoPipeline: pipelineMocks.watchRepoPipeline,
    listRepoPipelineIds: pipelineMocks.listRepoPipelineIds
  }
})

function pipelineFile(scope: 'repo'): OpenFile {
  const id = repoPipelineId
  const fileId = `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/${repoPipelineId}`
  return {
    id: fileId,
    filePath: fileId,
    relativePath: id,
    worktreeId,
    language: 'yaml',
    isDirty: false,
    runtimeEnvironmentId: null,
    pipeline: {
      scope,
      ref: id,
      worktreeId,
      readOnly: false
    },
    mode: 'pipeline'
  }
}

function seedWorkspace(file: OpenFile): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const repo: Repo = {
    id: 'repo-canvas',
    path: '/repo-canvas',
    displayName: 'Canvas repository',
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
  const worktree: Worktree = {
    id: worktreeId,
    repoId: repo.id,
    path: '/repo-canvas',
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Canvas repository',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    openFiles: [file]
  })
}

afterEach(() => {
  cleanup()
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

beforeEach(() => {
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  pipelineMocks.readRepoPipeline.mockReset()
  pipelineMocks.watchRepoPipeline.mockReset().mockReturnValue(() => undefined)
  pipelineMocks.listRepoPipelineIds.mockReset().mockResolvedValue([])
})

describe('PipelineCanvas run view across fleet refreshes', () => {
  it('keeps the pinned graph and open gate dialog mounted across a fleet refresh of an unchanged run', async () => {
    const file = pipelineFile('repo')
    seedWorkspace(file)
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline(runCanvasDocument()),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'saved-source' }
    })
    const row = pipelineRunRow('watcher-12', 12)
    const view = pinnedRunView('watcher-12', 12)
    const { fleet: fleetSpy, pipelineRunView: runViewSpy } = installCanvasRunApi(
      [row],
      new Map([[view.watcherId, view]])
    )
    useAppStore.setState({ hydrateHeimdallFleet: vi.fn(async () => {}) })

    render(<PipelineCanvas file={file} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Run (#12)' }))
    fireEvent.click(await screen.findByTestId('pipeline-run-node-approve'))
    await screen.findByTestId('pipeline-gate-dialog')
    const viewCalls = runViewSpy.mock.calls.length
    const fleetCalls = fleetSpy.mock.calls.length

    act(() => {
      useAppStore.setState({
        heimdallFleet: HeimdallFleetSnapshotReaderSchema.parse({
          entries: [row],
          generatedAtMs: 200
        })
      })
    })
    await waitFor(() => expect(fleetSpy.mock.calls.length).toBeGreaterThan(fleetCalls))
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByText('Loading pinned run…')).not.toBeInTheDocument()
    expect(screen.getByTestId('pipeline-gate-dialog')).toBeInTheDocument()
    expect(runViewSpy.mock.calls.length).toBe(viewCalls)
  })

  it('shows the loading placeholder when the selected run changes', async () => {
    const file = pipelineFile('repo')
    seedWorkspace(file)
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline(runCanvasDocument()),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'saved-source' }
    })
    const row12 = pipelineRunRow('watcher-12', 12)
    const row11 = pipelineRunRow('watcher-11', 11)
    const view12 = pinnedRunView('watcher-12', 12)
    const view11 = pinnedRunView('watcher-11', 11)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installCanvasRunApi(
      [row12, row11],
      new Map([
        [view12.watcherId, view12],
        [view11.watcherId, view11]
      ]),
      async (watcherId) => {
        if (watcherId === 'watcher-11') {
          await gate
        }
      }
    )
    useAppStore.setState({ hydrateHeimdallFleet: vi.fn(async () => {}) })

    render(<PipelineCanvas file={file} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Run (#12)' }))
    await screen.findByTestId('pipeline-run-node-approve')

    fireEvent.click(screen.getByRole('combobox', { name: 'Select pipeline run' }))
    fireEvent.click(screen.getByRole('option', { name: 'Run (#11)' }))

    expect(await screen.findByText('Loading pinned run…')).toBeInTheDocument()
    expect(screen.queryByTestId('pipeline-run-node-approve')).not.toBeInTheDocument()
    release()
    await screen.findByTestId('pipeline-run-node-fix')
  })
})
