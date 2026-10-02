// @vitest-environment happy-dom
import { createElement, Fragment, type ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type * as PipelineFileIo from './pipeline-file-io'
import type * as OpenPipelineTabModule from './open-pipeline-tab'
import type * as PipelineTabSave from './pipeline-tab-save'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  PipelineDocumentSchema,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { WatcherLedgerSchema, type WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import {
  HeimdallFleetSnapshotReaderSchema,
  type WatcherFleetEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { sha256 } from '../../../shared/sha256'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { PipelineCanvas } from './PipelineCanvas'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

type RepoPipelineWriteArgs = {
  worktreeId: string
  id: string
  yamlText: string
  layoutText: string
  ownerRef?: string
}

const pipelineMocks = vi.hoisted(() => ({
  readRepoPipeline: vi.fn(),
  watchRepoPipeline: vi.fn(() => () => undefined),
  listRepoPipelineIds: vi.fn(),
  writeRepoPipeline:
    vi.fn<(args: RepoPipelineWriteArgs) => Promise<{ mtime: number; sha256: string }>>(),
  openPipelineTab: vi.fn(),
  ensurePipelineTracked: vi.fn(),
  savePipelineDraft: vi.fn()
}))

const workspaceActivationMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: workspaceActivationMock
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

// Vitest's importOriginal is needed to preserve the production source-copy helper while replacing filesystem effects.
vi.mock('./pipeline-file-io', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineFileIo>()
  return {
    ...actual,
    readRepoPipeline: pipelineMocks.readRepoPipeline,
    watchRepoPipeline: pipelineMocks.watchRepoPipeline,
    listRepoPipelineIds: pipelineMocks.listRepoPipelineIds,
    writeRepoPipeline: pipelineMocks.writeRepoPipeline
  }
})

vi.mock('./open-pipeline-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenPipelineTabModule>()
  return { ...actual, openPipelineTab: pipelineMocks.openPipelineTab }
})

vi.mock('./pipeline-tab-save', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineTabSave>()
  return {
    ...actual,
    ensurePipelineTracked: pipelineMocks.ensurePipelineTracked,
    savePipelineDraft: pipelineMocks.savePipelineDraft
  }
})

const worktreeId = 'repo-canvas::/repo-canvas'
const repoPipelineId = 'bugfix'
const repoFileId = `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/${repoPipelineId}`
const builtinPipelineId = 'objective'
const builtinFileId = `heimdall-pipeline://builtin/${encodeURIComponent(worktreeId)}/${builtinPipelineId}`
const userFileId = `heimdall-pipeline://user/${encodeURIComponent(worktreeId)}/${repoPipelineId}`

function personalPipelineSignature(sourceText: string, mtime: number): string {
  const hash = [...sha256(new TextEncoder().encode(sourceText))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${mtime}:${hash}`
}

function repoDocument(): PipelineDocument {
  return {
    version: 1,
    id: repoPipelineId,
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes: [
      {
        id: 'fix',
        type: 'agent',
        prompt: 'Fix the issue',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'workers',
        type: 'swarm',
        after: ['fix'],
        worktree: 'own',
        from: '$fix.outputs.tasks',
        maxParallel: 3,
        child: { harness: 'codex', prompt: 'Work on the assigned task' }
      }
    ]
  }
}

function pipelineFile(scope: 'repo' | 'builtin'): OpenFile {
  const id = scope === 'repo' ? repoPipelineId : builtinPipelineId
  const fileId = scope === 'repo' ? repoFileId : builtinFileId
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
      ref: scope === 'builtin' ? `builtin:${id}` : id,
      worktreeId,
      readOnly: scope === 'builtin'
    },
    mode: 'pipeline'
  }
}

function missingPipelineFile(id = 'pipeline'): OpenFile {
  const template = pipelineFile('repo')
  const filePath = `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/${id}`
  return {
    ...template,
    id: filePath,
    filePath,
    relativePath: id,
    pipeline: { ...template.pipeline!, ref: id }
  }
}

function personalPipelineFile(): OpenFile {
  return {
    id: userFileId,
    filePath: userFileId,
    relativePath: repoPipelineId,
    worktreeId,
    language: 'yaml',
    isDirty: false,
    runtimeEnvironmentId: null,
    pipeline: { scope: 'user', ref: `user:${repoPipelineId}`, worktreeId, readOnly: false },
    mode: 'pipeline'
  }
}

function runCanvasDocument(): PipelineDocument {
  return {
    version: 1,
    id: repoPipelineId,
    name: 'Saved Bugfix',
    inputs: { task: { type: 'text', required: true, default: 'Repair the issue' } },
    defaults: { harness: 'codex' },
    nodes: [{ id: 'fix', type: 'agent', harness: 'codex', prompt: 'Fix the issue' }]
  }
}

function pipelineRunRow(
  watcherId: string,
  revision: number,
  readOnly = false
): WatcherFleetEntryReader {
  const base = buildWatcherFleetEntry(revision, 100, watcherId)
  const workspaceKey = `local::${worktreeId}`
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [
      {
        ...base,
        target: { watcherId, connectionId: null, pairingRevision: null },
        ownerFence: {
          executionHostId: 'local',
          schedulerOwner: 'local_host_service',
          workspaceKey,
          revision
        },
        contact: readOnly ? 'unverifiable' : 'live',
        readOnlyReason: readOnly ? 'The workspace owner is unavailable.' : null,
        entry: {
          ...base.entry,
          enrollment: {
            ...base.entry.enrollment,
            watcherId,
            kind: 'pipeline',
            workspaceKey,
            executionHostId: 'local',
            repoId: 'repo-canvas',
            worktreeId,
            workspacePath: '/repo-canvas',
            schedulerOwner: 'local_host_service',
            capabilities: { agent: 'gated' },
            kindPayload: { schemaVersion: 1 }
          },
          status: { ...base.entry.status, watcherId }
        }
      }
    ],
    generatedAtMs: 100
  })
  const row = snapshot.entries[0]
  if (!row) {
    throw new Error('The pipeline fleet fixture has no watcher row.')
  }
  return row
}

function pinnedRunView(watcherId: string, runNumber: number): PipelineRunView {
  const document = PipelineDocumentSchema.parse(
    runNumber === 12
      ? {
          version: 1,
          id: repoPipelineId,
          name: 'Pinned Bugfix 12',
          inputs: {},
          defaults: { harness: 'codex' },
          nodes: [
            { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the fix' },
            {
              id: 'approve',
              type: 'gate',
              label: 'Review run 12',
              after: ['build'],
              sendBackTo: 'build'
            }
          ]
        }
      : {
          version: 1,
          id: repoPipelineId,
          name: 'Pinned Bugfix 11',
          inputs: {},
          defaults: { harness: 'codex' },
          nodes: [
            {
              id: 'fix',
              type: 'agent',
              label: 'Pinned run 11 source',
              harness: 'codex',
              prompt: 'Fix from run 11'
            }
          ]
        }
  )
  const nodes =
    runNumber === 12
      ? [
          {
            instanceId: 'build',
            nodeId: 'build',
            type: 'agent',
            label: 'Completed run 12 build',
            status: 'done',
            epoch: 0,
            attempt: 1,
            turns: 0
          },
          {
            instanceId: 'approve',
            nodeId: 'approve',
            type: 'gate',
            label: 'Review run 12',
            status: 'waiting',
            waitingFor: 'gate',
            escalationId: `escalation-${watcherId}`,
            epoch: 0,
            attempt: 1,
            turns: 0
          }
        ]
      : [
          {
            instanceId: 'fix',
            nodeId: 'fix',
            type: 'agent',
            label: 'Pinned run 11 source',
            status: 'done',
            epoch: 0,
            attempt: 1,
            turns: 0
          }
        ]
  return PipelineRunViewSchema.parse({
    watcherId,
    kind: 'pipeline',
    pin: {
      ref: repoPipelineId,
      scope: 'repo',
      id: repoPipelineId,
      contentHash: pipelineContentHash(document),
      documentVersion: 1,
      runNumber,
      label: `Bugfix run ${runNumber}`
    },
    document,
    nodes,
    edges: runNumber === 12 ? [{ from: 'build', to: 'approve' }] : [],
    asOfMs: 100
  })
}

function ledgerForRun(view: PipelineRunView): WatcherLedger {
  if (view.pin.runNumber !== 12) {
    return WatcherLedgerSchema.parse({ watcherId: view.watcherId, entries: [] })
  }
  return WatcherLedgerSchema.parse({
    watcherId: view.watcherId,
    entries: [
      {
        eventId: `event-${view.watcherId}`,
        watcherId: view.watcherId,
        atMs: 10,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        escalationId: `escalation-${view.watcherId}`,
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 1,
        approvalScope: {
          actionKind: 'pipeline-pass-gate',
          contentIdentity: `pipeline:${view.pin.contentHash}`,
          evidenceKey: makePipelineNodeEvidenceKey({
            instanceId: 'approve',
            epoch: 0,
            attempt: 1,
            cause: 'gate'
          })
        }
      }
    ]
  })
}

const canvasRunApi = { command: vi.fn() }

function installCanvasRunApi(
  rows: readonly WatcherFleetEntryReader[],
  views: ReadonlyMap<string, PipelineRunView>
): void {
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({ entries: rows, generatedAtMs: 100 })
  const ledgers = new Map([...views.values()].map((view) => [view.watcherId, ledgerForRun(view)]))
  canvasRunApi.command.mockReset().mockResolvedValue({ status: 'applied', appliedAtMs: 100 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: vi.fn(),
        onFleetChanged: () => () => undefined,
        pipelineList: async () => ({
          pipelines: [
            {
              ref: repoPipelineId,
              scope: 'repo',
              id: repoPipelineId,
              name: 'Bugfix',
              valid: true,
              errorCount: 0,
              contentHash: pipelineContentHash(runCanvasDocument()),
              liveRuns: [...views.values()].map((view) => ({
                watcherId: view.watcherId,
                runNumber: view.pin.runNumber,
                contentHash: view.pin.contentHash
              }))
            }
          ]
        }),
        fleet: async () => snapshot,
        pipelineRunView: async ({ watcherId }: { watcherId: string }) => {
          const view = views.get(watcherId)
          if (!view) {
            throw new Error(`Run ${watcherId} is missing.`)
          }
          return view
        },
        detail: async ({ watcherId }: { watcherId: string }) => ({
          ledger: ledgers.get(watcherId)
        }),
        command: canvasRunApi.command
      }
    }
  })
}

const editorRunApi = { pipelineResolve: vi.fn() }

function installEditorRunApi(sourceText: string): void {
  const parsed = parsePipelineText(sourceText)
  if (parsed.sourceDocument === undefined) {
    throw new Error('The editor run fixture must be valid pipeline YAML.')
  }
  const document = parsed.document
  const contentHash = document ? pipelineContentHash(document) : null
  editorRunApi.pipelineResolve.mockReset().mockResolvedValue({
    ref: repoPipelineId,
    scope: 'repo',
    id: repoPipelineId,
    sourceText,
    layoutText: null,
    document,
    contentHash,
    errors: parsed.errors
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: vi.fn(),
        onFleetChanged: () => () => undefined,
        pipelineList: async () => ({
          pipelines: [
            {
              ref: 'builtin:objective',
              scope: 'builtin',
              id: 'objective',
              name: 'Objective',
              valid: true,
              errorCount: 0,
              contentHash: null,
              liveRuns: []
            },
            {
              ref: 'builtin:pr-sitter',
              scope: 'builtin',
              id: 'pr-sitter',
              name: 'PR sitter',
              valid: true,
              errorCount: 0,
              contentHash: null,
              liveRuns: []
            },
            {
              ref: repoPipelineId,
              scope: 'repo',
              id: repoPipelineId,
              name: document?.name ?? repoPipelineId,
              valid: document !== null,
              errorCount: parsed.errors.length,
              contentHash,
              liveRuns: []
            }
          ]
        }),
        pipelineResolve: editorRunApi.pipelineResolve,
        pipelinePersonal: async () => ({ pipelines: [] })
      }
    }
  })
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

function loadMissingPipelineDraft(filePath: string, expectedId: string): void {
  usePipelineCanvasDraftStore.getState().load(filePath, {
    sourceText: '',
    layout: null,
    signature: null,
    sourceExists: false,
    expectedId,
    validationContext: { workspaceKind: 'git', expectedId }
  })
}
afterEach(() => {
  cleanup()
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

beforeEach(() => {
  workspaceActivationMock.mockReset().mockReturnValue(true)
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  pipelineMocks.readRepoPipeline.mockReset()
  pipelineMocks.watchRepoPipeline.mockReset().mockReturnValue(() => undefined)
  pipelineMocks.listRepoPipelineIds.mockReset().mockResolvedValue([])
  pipelineMocks.writeRepoPipeline.mockReset().mockResolvedValue({ mtime: 10, sha256: 'saved' })
  pipelineMocks.openPipelineTab.mockReset().mockReturnValue('copied-pipeline-tab')
  pipelineMocks.ensurePipelineTracked.mockReset().mockResolvedValue(null)
  pipelineMocks.savePipelineDraft.mockReset()
})

describe('PipelineCanvas graph surface', () => {
  it('shows repo palette, graph, and inspector in order, and selects a validation node', async () => {
    const document = repoDocument()
    const file = pipelineFile('repo')
    seedWorkspace(file)
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline(document),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'repo-draft' }
    })

    render(<PipelineCanvas file={file} />)

    const graph = await screen.findByRole('application', { name: 'Pipeline graph' })
    expect(screen.getByRole('button', { name: 'Run pipeline' })).toBeDisabled()
    const palette = screen.getByRole('complementary', { name: 'Nodes' })
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    const workspace = palette.parentElement
    expect(workspace?.children.item(0)).toBe(palette)
    expect(workspace?.children.item(1)?.contains(graph)).toBe(true)
    expect(workspace?.children.item(2)).toBe(inspector)

    const validation = screen.getByRole('region', { name: 'Validation errors' })
    const invalidNodeLink = within(validation).getByRole('button', { name: 'fix' })
    fireEvent.click(invalidNodeLink)

    expect(within(graph).getByRole('button', { name: 'Select node fix' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(within(inspector).getByRole('heading', { name: 'fix' })).toBeInTheDocument()
    expect(within(inspector).getByLabelText('Harness')).toHaveValue('')
  })

  it('keeps built-in inspection read-only and duplicates the built-in into the repository', async () => {
    const file = pipelineFile('builtin')
    seedWorkspace(file)
    pipelineMocks.listRepoPipelineIds.mockResolvedValue(['objective', 'objective-2'])

    render(<PipelineCanvas file={file} />)

    const graph = await screen.findByRole('application', { name: 'Pipeline graph' })
    const inspector = screen.getByRole('complementary', { name: 'Inspector' })
    fireEvent.click(within(graph).getByRole('button', { name: 'Select node objective' }))

    expect(inspector.querySelector('input, textarea, select, [role="combobox"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate to repo' }))

    await waitFor(() => expect(pipelineMocks.writeRepoPipeline).toHaveBeenCalledTimes(1))
    const write = pipelineMocks.writeRepoPipeline.mock.calls[0]?.[0]
    const copiedDocument = parsePipelineText(write?.yamlText ?? '').document
    expect(write).toMatchObject({ worktreeId, id: 'objective-3', ownerRef: 'builtin:objective' })
    expect(copiedDocument).toMatchObject({ id: 'objective-3', name: 'Objective copy' })
    expect(pipelineMocks.openPipelineTab).toHaveBeenCalledWith({
      scope: 'repo',
      worktreeId,
      id: 'objective-3'
    })
  })
  it('shows only the selected pinned graph, scopes answers to its fleet owner fence, and returns to Edit mode', async () => {
    const file = pipelineFile('repo')
    seedWorkspace(file)
    const savedDocument = runCanvasDocument()
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline(savedDocument),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'saved-source' }
    })
    const row12 = pipelineRunRow('watcher-12', 12)
    const row11 = pipelineRunRow('watcher-11', 11)
    const view12 = pinnedRunView('watcher-12', 12)
    const view11 = pinnedRunView('watcher-11', 11)
    installCanvasRunApi(
      [row12, row11],
      new Map([
        [view12.watcherId, view12],
        [view11.watcherId, view11]
      ])
    )
    useAppStore.setState({ hydrateHeimdallFleet: vi.fn(async () => {}) })

    render(<PipelineCanvas file={file} />)
    const runMode = await screen.findByRole('radio', { name: 'Run (#12)' })
    fireEvent.click(runMode)

    const pinnedGate = await screen.findByTestId('pipeline-run-node-approve')
    expect(pinnedGate).toHaveTextContent('Review run 12')
    expect(screen.getByText('Differs from saved')).toBeInTheDocument()
    fireEvent.click(pinnedGate)
    await screen.findByTestId('pipeline-gate-dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    const scope = {
      actionKind: 'pipeline-pass-gate',
      contentIdentity: `pipeline:${view12.pin.contentHash}`,
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'approve',
        epoch: 0,
        attempt: 1,
        cause: 'gate'
      })
    }
    await waitFor(() =>
      expect(canvasRunApi.command).toHaveBeenCalledWith({
        target: row12.target,
        expectedOwner: row12.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope,
          choice: 'approve',
          surface: 'canvas-run'
        }
      })
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Select pipeline run' }))
    fireEvent.click(screen.getByRole('option', { name: 'Run (#11)' }))
    await waitFor(() =>
      expect(screen.getByTestId('pipeline-run-node-fix')).toHaveTextContent('Pinned run 11 source')
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }))

    expect(screen.queryByTestId('pipeline-run-node-fix')).not.toBeInTheDocument()
    expect(screen.queryByText('Differs from saved')).not.toBeInTheDocument()
  })

  it('keeps a gate answer disabled when the actual selected fleet row is unverifiable', async () => {
    const file = pipelineFile('repo')
    seedWorkspace(file)
    const savedDocument = runCanvasDocument()
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline(savedDocument),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'saved-source' }
    })
    const row = pipelineRunRow('watcher-12', 12, true)
    const view = pinnedRunView('watcher-12', 12)
    installCanvasRunApi([row], new Map([[view.watcherId, view]]))

    render(<PipelineCanvas file={file} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Run (#12)' }))
    fireEvent.click(await screen.findByTestId('pipeline-run-node-approve'))
    await screen.findByTestId('pipeline-gate-dialog')

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(canvasRunApi.command).not.toHaveBeenCalled()
  })
  it('prevents dirty runs until Save and run completes and opens the pipeline input form', async () => {
    const file = pipelineFile('repo')
    const savedDocument = runCanvasDocument()
    const savedText = renderNewPipeline(savedDocument)
    seedWorkspace(file)
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: savedText,
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'saved-source' }
    })
    pipelineMocks.savePipelineDraft.mockResolvedValue({
      status: 'saved',
      clean: true,
      fileWasRerendered: false,
      tracking: null,
      scope: 'repo',
      pipelineId: repoPipelineId
    })
    installEditorRunApi(savedText)
    useAppStore.setState({
      fetchAllWorktrees: vi.fn(async () => {}),
      hydrateHeimdallFleet: vi.fn(async () => {})
    })
    render(<PipelineCanvas file={file} />)
    await screen.findByRole('button', { name: 'Run pipeline' })

    fireEvent.change(screen.getByRole('textbox', { name: 'Pipeline name' }), {
      target: { value: 'Unsaved Bugfix' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
    const unsavedDialog = await screen.findByRole('dialog')
    expect(pipelineMocks.savePipelineDraft).not.toHaveBeenCalled()
    expect(screen.queryByRole('form', { name: 'Run pipeline' })).not.toBeInTheDocument()
    fireEvent.click(within(unsavedDialog).getByRole('button', { name: 'Cancel' }))
    expect(pipelineMocks.savePipelineDraft).not.toHaveBeenCalled()
    expect(screen.queryByRole('form', { name: 'Run pipeline' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Save and run' }))

    const runForm = await screen.findByRole('form', { name: 'Run pipeline' })
    expect(runForm).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /task/i })).toHaveValue('Repair the issue')
    expect(pipelineMocks.savePipelineDraft).toHaveBeenCalledTimes(1)
    expect(pipelineMocks.savePipelineDraft).toHaveBeenCalledWith(file.id, {
      allowFileRerender: false,
      targetScope: 'repo'
    })
  })

  it('saves a missing draft under its authored id and enables Run with the saved ref', async () => {
    const initialId = 'pipeline'
    const file = missingPipelineFile(initialId)
    const disk = new Map<
      string,
      {
        yamlText: string
        layoutText: string | null
        layout: null
        signature: { mtime: number; sha256: string }
      }
    >()
    const actualSave = await vi.importActual<typeof PipelineTabSave>('./pipeline-tab-save')
    const actualOpen = await vi.importActual<typeof OpenPipelineTabModule>('./open-pipeline-tab')
    pipelineMocks.savePipelineDraft.mockImplementation(actualSave.savePipelineDraft)
    pipelineMocks.openPipelineTab.mockImplementation(actualOpen.openPipelineTab)
    pipelineMocks.readRepoPipeline.mockImplementation(async ({ id }: { id: string }) => {
      return disk.get(id) ?? null
    })
    pipelineMocks.writeRepoPipeline.mockImplementation(
      async ({ id, yamlText, layoutText }: RepoPipelineWriteArgs) => {
        const signature = { mtime: disk.size + 20, sha256: `${id}-saved` }
        disk.set(id, { yamlText, layoutText, layout: null, signature })
        return signature
      }
    )
    const authoredDocument = { ...runCanvasDocument(), name: 'Bugfix(fast)' }
    installEditorRunApi(renderNewPipeline(authoredDocument))
    seedWorkspace(file)
    useAppStore.setState({
      fetchAllWorktrees: vi.fn(async () => {}),
      hydrateHeimdallFleet: vi.fn(async () => {})
    })

    const { rerender } = render(<PipelineCanvas file={file} />)
    await screen.findByRole('textbox', { name: 'Pipeline id' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Pipeline id' }), {
      target: { value: authoredDocument.id }
    })
    usePipelineCanvasDraftStore.getState().editDocument(file.id, () => authoredDocument)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const saveDialog = await screen.findByRole('dialog')
    fireEvent.click(within(saveDialog).getByRole('button', { name: 'This repo' }))

    await waitFor(() =>
      expect(pipelineMocks.writeRepoPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ id: authoredDocument.id })
      )
    )
    const savedFile = await waitFor(() => {
      const candidate = useAppStore
        .getState()
        .openFiles.find((openFile) => openFile.pipeline?.ref === authoredDocument.id)
      expect(candidate).toBeDefined()
      return candidate!
    })
    rerender(<PipelineCanvas file={savedFile} />)
    const runButton = await screen.findByRole('button', { name: 'Run pipeline' })
    await waitFor(() => expect(runButton).toBeEnabled())
    fireEvent.click(runButton)

    await screen.findByRole('form', { name: 'Run pipeline' })
    await waitFor(() =>
      expect(editorRunApi.pipelineResolve).toHaveBeenCalledWith({
        workspace: { repoId: 'repo-canvas', worktreeId },
        ref: authoredDocument.id
      })
    )
  })

  it('refuses to overwrite an existing pipeline when a new draft adopts its id', async () => {
    const initialId = 'pipeline'
    const file = missingPipelineFile(initialId)
    seedWorkspace(file)
    loadMissingPipelineDraft(file.id, initialId)
    usePipelineCanvasDraftStore
      .getState()
      .editDocument(file.id, (document) => ({ ...document, id: repoPipelineId }))
    pipelineMocks.readRepoPipeline.mockResolvedValue({
      yamlText: renderNewPipeline({ ...runCanvasDocument(), name: 'Existing pipeline' }),
      layoutText: null,
      layout: null,
      signature: { mtime: 10, sha256: 'existing-pipeline' }
    })
    const actualSave = await vi.importActual<typeof PipelineTabSave>('./pipeline-tab-save')

    const result = await actualSave.savePipelineDraft(file.id, { targetScope: 'repo' })

    expect(result).toMatchObject({
      status: 'failed',
      message: 'A pipeline with this id already exists or is open in the selected location.'
    })
    expect(pipelineMocks.writeRepoPipeline).not.toHaveBeenCalled()
  })

  it('rejects an invalid authored id instead of saving the generated draft id', async () => {
    const initialId = 'pipeline'
    const file = missingPipelineFile(initialId)
    seedWorkspace(file)
    loadMissingPipelineDraft(file.id, initialId)
    usePipelineCanvasDraftStore
      .getState()
      .editDocument(file.id, (document) => ({ ...document, id: 'Bugfix!' }))
    const actualSave = await vi.importActual<typeof PipelineTabSave>('./pipeline-tab-save')

    const result = await actualSave.savePipelineDraft(file.id, { targetScope: 'repo' })

    expect(result).toMatchObject({
      status: 'failed',
      message: 'This pipeline id is invalid.'
    })
    expect(pipelineMocks.readRepoPipeline).not.toHaveBeenCalled()
    expect(pipelineMocks.writeRepoPipeline).not.toHaveBeenCalled()
  })

  it('allows a new draft with an empty graph to save under its authored id', async () => {
    const initialId = 'pipeline'
    const file = missingPipelineFile(initialId)
    seedWorkspace(file)
    loadMissingPipelineDraft(file.id, initialId)
    usePipelineCanvasDraftStore
      .getState()
      .editDocument(file.id, (document) => ({ ...document, id: 'unfinished' }))
    pipelineMocks.readRepoPipeline.mockResolvedValue(null)
    installEditorRunApi(renderNewPipeline({ ...runCanvasDocument(), id: 'unfinished', nodes: [] }))
    const actualSave = await vi.importActual<typeof PipelineTabSave>('./pipeline-tab-save')

    const result = await actualSave.savePipelineDraft(file.id, { targetScope: 'repo' })

    expect(result).toMatchObject({ status: 'saved', pipelineId: 'unfinished', scope: 'repo' })
    expect(pipelineMocks.writeRepoPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'unfinished' })
    )
  })
  it('surfaces a personal-file change while dirty and Reload adopts the disk version', async () => {
    const file = personalPipelineFile()
    seedWorkspace(file)
    let diskText = renderNewPipeline(runCanvasDocument())
    let diskSignature = personalPipelineSignature(diskText, 10)
    const pipelinePersonal = vi.fn(async ({ op }: { op: string }) => {
      if (op === 'stat') {
        return { signature: diskSignature }
      }
      if (op === 'read') {
        return { yamlText: diskText, layoutText: null, signature: diskSignature }
      }
      return { pipelines: [] }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        heimdall: {
          enroll: vi.fn(),
          onFleetChanged: () => () => undefined,
          pipelineList: async () => ({ pipelines: [] }),
          fleet: async () => ({ entries: [], generatedAtMs: 100 }),
          pipelinePersonal
        }
      }
    })
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    try {
      render(<PipelineCanvas file={file} />)
      await screen.findByRole('application', { name: 'Pipeline graph' })
      const name = await screen.findByRole('textbox', { name: 'Pipeline name' })
      fireEvent.change(name, { target: { value: 'My unsaved change' } })

      diskText = renderNewPipeline({ ...runCanvasDocument(), name: 'Disk version' })
      diskSignature = personalPipelineSignature(diskText, 11)
      document.dispatchEvent(new Event('visibilitychange'))

      const banner = await screen.findByRole('alert')
      fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }))

      await waitFor(() =>
        expect(screen.getByRole('textbox', { name: 'Pipeline name' })).toHaveValue('Disk version')
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByText('Edited')).not.toBeInTheDocument()
    } finally {
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor)
      } else {
        Reflect.deleteProperty(document, 'visibilityState')
      }
    }
  })
})
