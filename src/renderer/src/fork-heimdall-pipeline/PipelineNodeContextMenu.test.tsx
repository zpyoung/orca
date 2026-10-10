// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WatcherWorkerNavigation } from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { PipelineCanvasGraph } from './PipelineCanvasGraph'
import {
  PipelineNodeContextMenu,
  type PipelineNodeContextMenuItem
} from './PipelineNodeContextMenu'
import { PipelineRunGraph } from './PipelineRunGraph'
import {
  ledgerForRun,
  pinnedRunView,
  pipelineRunRow,
  repoPipelineId,
  worktreeId
} from './pipeline-canvas-run-fixtures'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

const { openWorker, resolveWorkerNavigation } = vi.hoisted(() => ({
  openWorker: vi.fn(),
  resolveWorkerNavigation: vi.fn(
    (navigation: { worktreeId: string; executionHostId: string; paneKey: string }) => navigation
  )
}))

vi.mock('@/fork-heimdall/heimdall-worker-navigation', () => ({
  openHeimdallWorker: openWorker,
  resolveHeimdallWorkerNavigation: resolveWorkerNavigation
}))

const writeClipboardText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText } }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
})

function menuLabels(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

function openAndDismissMenuOn(node: Element): void {
  fireEvent.contextMenu(node)
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
}

describe('PipelineNodeContextMenu', () => {
  type FakeNode = { id: string }

  function renderHarness(getItems: (node: FakeNode) => readonly PipelineNodeContextMenuItem[]) {
    return render(
      <PipelineNodeContextMenu<FakeNode> data-testid="flow" className="flow" getItems={getItems}>
        {(onNodeContextMenu) => (
          <div data-testid="pane">
            <button
              type="button"
              data-testid="node-a"
              onContextMenu={(event) => onNodeContextMenu(event, { id: 'node-a' })}
            >
              Node A
            </button>
          </div>
        )}
      </PipelineNodeContextMenu>
    )
  }

  it('lists the items for the right-clicked node and runs the chosen one', () => {
    const onInspect = vi.fn()
    const getItems = vi.fn((node: FakeNode) => [
      { key: 'inspect', label: `Inspect ${node.id}`, onSelect: onInspect },
      { key: 'delete', label: 'Delete', onSelect: vi.fn(), destructive: true }
    ])
    renderHarness(getItems)

    fireEvent.contextMenu(screen.getByTestId('node-a'))

    expect(menuLabels()).toEqual(['Inspect node-a', 'Delete'])
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'data-variant',
      'destructive'
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Inspect node-a' }))
    expect(onInspect).toHaveBeenCalledTimes(1)
  })

  it('opens no menu for a click that is not on a node, even after a node was right-clicked', () => {
    renderHarness(() => [{ key: 'inspect', label: 'Inspect', onSelect: vi.fn() }])
    openAndDismissMenuOn(screen.getByTestId('node-a'))

    fireEvent.contextMenu(screen.getByTestId('pane'))

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the flow container attributes on the single wrapper element', () => {
    renderHarness(() => [])

    const flow = screen.getByTestId('flow')

    expect(flow).toHaveClass('flow')
    expect(flow.firstElementChild).toBe(screen.getByTestId('pane'))
  })
})

describe('PipelineNodeContextMenu on the run graph', () => {
  const navigation: WatcherWorkerNavigation = {
    worktreeId: 'worktree-1',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    paneKey: 'tab-1:leaf-1'
  }

  function viewWithBuild(status: 'running' | 'done', withNavigation: boolean): PipelineRunView {
    const view = pinnedRunView('watcher-12', 12)
    return PipelineRunViewSchema.parse({
      ...view,
      nodes: view.nodes.map((node) =>
        node.instanceId === 'build'
          ? { ...node, status, ...(withNavigation ? { workerNavigation: navigation } : {}) }
          : node
      )
    })
  }

  function renderRunGraph(view: PipelineRunView, ledger: WatcherLedger | null) {
    return render(
      <PipelineRunGraph
        view={view}
        surface="canvas-run"
        row={pipelineRunRow('watcher-12', 12)}
        ledger={ledger}
        onAnswer={vi.fn().mockResolvedValue({ status: 'applied', appliedAtMs: 100 })}
      />
    )
  }

  it('offers the worker terminal and the node id for a running agent, and opens the worker', () => {
    const view = viewWithBuild('running', true)
    renderRunGraph(view, ledgerForRun(view))

    fireEvent.contextMenu(screen.getByTestId('pipeline-run-node-build'))

    expect(menuLabels()).toEqual(['Open worker terminal', 'Copy node ID'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open worker terminal' }))
    expect(resolveWorkerNavigation).toHaveBeenCalledWith(navigation, null)
    expect(openWorker).toHaveBeenCalledWith(navigation)
  })

  it('omits the worker terminal when the node has no live worker', () => {
    const view = viewWithBuild('done', true)
    renderRunGraph(view, ledgerForRun(view))

    fireEvent.contextMenu(screen.getByTestId('pipeline-run-node-build'))

    expect(menuLabels()).toEqual(['Copy node ID'])
  })

  it('offers Answer for a waiting gate and opens the same dialog a click opens', async () => {
    const view = viewWithBuild('done', false)
    renderRunGraph(view, ledgerForRun(view))

    fireEvent.contextMenu(screen.getByTestId('pipeline-run-node-approve'))

    expect(menuLabels()).toEqual(['Answer', 'Copy node ID'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Answer' }))
    expect(await screen.findByTestId('pipeline-gate-dialog')).toBeInTheDocument()
  })

  it('omits Answer when the click would refuse to open a control', () => {
    const view = viewWithBuild('done', false)
    renderRunGraph(view, null)

    fireEvent.click(screen.getByTestId('pipeline-run-node-approve'))
    expect(screen.queryByTestId('pipeline-gate-dialog')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('pipeline-run-node-approve'))

    expect(menuLabels()).toEqual(['Copy node ID'])
  })

  it('copies the node id', () => {
    const view = viewWithBuild('done', false)
    renderRunGraph(view, null)

    fireEvent.contextMenu(screen.getByTestId('pipeline-run-node-approve'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy node ID' }))

    expect(writeClipboardText).toHaveBeenCalledWith('approve')
  })

  it('opens no menu on the pane', () => {
    const view = viewWithBuild('running', true)
    const { container } = renderRunGraph(view, ledgerForRun(view))
    openAndDismissMenuOn(screen.getByTestId('pipeline-run-node-build'))

    fireEvent.contextMenu(container.querySelector('.react-flow__pane')!)

    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('PipelineNodeContextMenu on the edit graph', () => {
  const file: OpenFile = {
    id: `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/${repoPipelineId}`,
    filePath: 'unused',
    relativePath: repoPipelineId,
    worktreeId,
    language: 'yaml',
    isDirty: false,
    runtimeEnvironmentId: null,
    mode: 'pipeline'
  }
  const document: PipelineDocument = {
    version: 1,
    id: repoPipelineId,
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes: [
      { id: 'fix', type: 'agent', harness: 'codex', prompt: 'Fix the issue' },
      { id: 'check', type: 'check', command: 'true', after: ['fix'] }
    ]
  }

  function EditGraph({
    readOnly,
    selectedNodeId,
    onSelectNode
  }: {
    readOnly: boolean
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void
  }): React.JSX.Element | null {
    const draft = usePipelineCanvasDraftStore((state) => state.drafts[file.id])
    if (!draft) {
      return null
    }
    return (
      <ReactFlowProvider>
        <PipelineCanvasGraph
          file={file}
          draft={draft}
          selectedNodeId={selectedNodeId}
          readOnly={readOnly}
          onSelectNode={onSelectNode}
          onAddNode={vi.fn()}
        />
      </ReactFlowProvider>
    )
  }

  function renderEditGraph(
    readOnly: boolean,
    selectedNodeId: string | null = null,
    onSelectNode = vi.fn()
  ) {
    usePipelineCanvasDraftStore.getState().load(file.id, {
      sourceText: renderNewPipeline(document),
      layout: null,
      signature: { mtime: 1, sha256: 'saved' },
      sourceExists: true,
      expectedId: repoPipelineId,
      validationContext: { workspaceKind: 'git', expectedId: repoPipelineId }
    })
    const view = render(
      <EditGraph readOnly={readOnly} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
    )
    return { ...view, onSelectNode }
  }

  function flowNode(container: HTMLElement, id: string): Element {
    const node = container.querySelector(`.react-flow__node[data-id="${id}"]`)
    if (!node) {
      throw new Error(`The flow node ${id} did not render`)
    }
    return node
  }

  it('offers Inspect, Delete node and Copy node ID, and inspects the node', () => {
    const { container, onSelectNode } = renderEditGraph(false)

    fireEvent.contextMenu(flowNode(container, 'fix'))

    expect(menuLabels()).toEqual(['Inspect', 'Delete node', 'Copy node ID'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Inspect' }))
    expect(onSelectNode).toHaveBeenCalledWith('fix')
  })

  it('deletes the node from the draft and clears the selection when it was selected', async () => {
    const { container, onSelectNode } = renderEditGraph(false, 'fix')

    fireEvent.contextMenu(flowNode(container, 'fix'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete node' }))

    await waitFor(() =>
      expect(
        usePipelineCanvasDraftStore.getState().drafts[file.id]?.draftDocument.nodes.map((n) => n.id)
      ).toEqual(['check'])
    )
    expect(onSelectNode).toHaveBeenCalledWith(null)
  })

  it('keeps another node selected when a different node is deleted', async () => {
    const { container, onSelectNode } = renderEditGraph(false, 'check')

    fireEvent.contextMenu(flowNode(container, 'fix'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete node' }))

    await waitFor(() =>
      expect(
        usePipelineCanvasDraftStore.getState().drafts[file.id]?.draftDocument.nodes.map((n) => n.id)
      ).toEqual(['check'])
    )
    expect(onSelectNode).not.toHaveBeenCalled()
  })

  it('hides Delete node on a read-only graph', () => {
    const { container } = renderEditGraph(true)

    fireEvent.contextMenu(flowNode(container, 'fix'))

    expect(menuLabels()).toEqual(['Inspect', 'Copy node ID'])
  })

  it('copies the node id', () => {
    const { container } = renderEditGraph(false)

    fireEvent.contextMenu(flowNode(container, 'check'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy node ID' }))

    expect(writeClipboardText).toHaveBeenCalledWith('check')
  })

  it('opens no menu on the pane', () => {
    const { container } = renderEditGraph(false)
    openAndDismissMenuOn(flowNode(container, 'fix'))

    fireEvent.contextMenu(container.querySelector('.react-flow__pane')!)

    expect(screen.queryByRole('menu')).toBeNull()
  })
})
