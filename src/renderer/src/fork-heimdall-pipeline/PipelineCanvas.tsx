import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import '@xyflow/react/dist/style.css'
import './pipeline-canvas.css'
import { ReactFlowProvider } from '@xyflow/react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type {
  WatcherDetailReader,
  WatcherFleetEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import {
  PipelineDocumentSchema,
  type NodeType,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import {
  renderNewPipeline,
  applyPipelineEdits
} from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type { PipelineRunView } from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  PipelineCanvasHeader,
  type PipelineCanvasMode,
  type PipelineCanvasView,
  type PipelineRunOption
} from './PipelineCanvasHeader'
import type { PipelineChoiceCommand } from './PipelineGateDialog'
import { PipelineCanvasGraph } from './PipelineCanvasGraph'
import { PipelineExternalChangeBanner } from './PipelineExternalChangeBanner'
import { PipelineInspector } from './PipelineInspector'
import { PipelinePalette } from './PipelinePalette'
import { PipelineRunGraph } from './PipelineRunGraph'
import { PipelineTrackingNotice } from './PipelineTrackingNotice'
import { PipelineValidationList } from './PipelineValidationList'
import { PipelineYamlPreview } from './PipelineYamlPreview'
import { createPipelineNode, nextPipelineNodeId } from './pipeline-document-factory'
import {
  copyPipelineSource,
  listRepoPipelineIds,
  nextFreePipelineId,
  writeRepoPipeline
} from './pipeline-file-io'
import { layeredLayout } from './layered-layout'
import { openPipelineTab } from './open-pipeline-tab'
import {
  diffPipelineDocument,
  renderPipelineLayoutForDocument
} from './pipeline-canvas-document-edits'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import {
  answerPipelineCanvasChoice,
  approvePipelineCanvasAction,
  loadPipelineCanvasRunDetail,
  loadPipelineCanvasRuns
} from './pipeline-canvas-run-session'
import { PipelineCanvasRunDialogs } from './PipelineCanvasRunDialogs'
import { usePipelineCanvasSaveSession } from './pipeline-canvas-save-session'
import { pipelineIdFromRef, usePipelineCanvasSourceSession } from './pipeline-canvas-source-session'

function PipelineCanvasBody({ file }: { file: OpenFile }): JSX.Element {
  const pipeline = file.pipeline
  const draft = usePipelineCanvasDraftStore((state) => state.drafts[file.id])
  const markFileDirty = useAppStore((state) => state.markFileDirty)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const fleetSnapshot = useAppStore((state) => state.heimdallFleet)
  const [view, setView] = useState<PipelineCanvasView>('graph')
  const [mode, setMode] = useState<PipelineCanvasMode>('edit')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [liveRuns, setLiveRuns] = useState<PipelineRunOption[]>([])
  const [runRowsById, setRunRowsById] = useState<Record<string, WatcherFleetEntryReader>>({})
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runView, setRunView] = useState<PipelineRunView | null>(null)
  const [runRow, setRunRow] = useState<WatcherFleetEntryReader | null>(null)
  const [runLedger, setRunLedger] = useState<WatcherDetailReader['ledger'] | null>(null)
  const [runViewLoading, setRunViewLoading] = useState(false)
  const [runViewError, setRunViewError] = useState<string | null>(null)
  const [runRefreshRevision, setRunRefreshRevision] = useState(0)
  const readOnly = pipeline?.readOnly === true
  const id = pipeline ? pipelineIdFromRef(pipeline.scope, pipeline.ref) : ''
  const {
    savedScope,
    saving,
    replaceFileDialogOpen,
    onReplaceFileOpenChange,
    saveToChoiceOpen,
    onSaveToChoiceOpenChange,
    unsavedRunDialogOpen,
    setUnsavedRunDialogOpen,
    runSheetOpen,
    runSheetInitialRef,
    trackingResult,
    trackingReincludeAvailable,
    runDisabled,
    performSave,
    requestSave,
    requestRun,
    saveAndRun,
    chooseSaveScope,
    trackRepoCopy,
    reincludePipelines,
    handleRunSheetOpenChange,
    dismissTracking
  } = usePipelineCanvasSaveSession({ file, draft, readOnly })
  const { loaded, loadError } = usePipelineCanvasSourceSession({ file, id, savedScope })

  useEffect(() => {
    if (draft) {
      markFileDirty(file.id, draft.dirty)
    }
  }, [draft?.dirty, file.id, markFileDirty, draft])

  useEffect(() => {
    if (!pipeline || !loaded) {
      return
    }
    let disposed = false
    setRunViewError(null)
    const loadRuns = async (): Promise<void> => {
      const worktree = useAppStore.getState().getKnownWorktreeById(file.worktreeId)
      if (!worktree?.repoId) {
        setLiveRuns([])
        setRunRowsById({})
        setSelectedRunId(null)
        return
      }
      const result = await loadPipelineCanvasRuns({
        repoId: worktree.repoId,
        worktreeId: file.worktreeId,
        scope: savedScope,
        id
      })
      if (disposed) {
        return
      }
      setRunRowsById({ ...result.rowsById })
      setLiveRuns(result.options)
      setSelectedRunId((current) =>
        current && result.options.some((run) => run.watcherId === current)
          ? current
          : (result.options[0]?.watcherId ?? null)
      )
      if (result.options.length === 0) {
        setMode('edit')
      }
    }
    void loadRuns().catch((error: unknown) => {
      if (!disposed) {
        setRunViewError(error instanceof Error ? error.message : String(error))
        setLiveRuns([])
        setRunRowsById({})
      }
    })
    return () => {
      disposed = true
    }
  }, [file.worktreeId, fleetSnapshot?.generatedAtMs, id, loaded, pipeline, savedScope])

  useEffect(() => {
    if (mode !== 'run' || !selectedRunId) {
      setRunView(null)
      setRunRow(null)
      setRunLedger(null)
      setRunViewError(null)
      setRunViewLoading(false)
      return
    }
    const row = runRowsById[selectedRunId]
    if (!row) {
      setRunView(null)
      setRunRow(null)
      setRunLedger(null)
      setRunViewError(
        translate(
          'fork.heimdallPipeline.runGraph.runUnavailable',
          'This run is no longer available in the current fleet snapshot.'
        )
      )
      return
    }
    let disposed = false
    setRunViewLoading(true)
    setRunViewError(null)
    const ref =
      savedScope === 'user' ? `user:${id}` : savedScope === 'builtin' ? `builtin:${id}` : id
    void loadPipelineCanvasRunDetail({ row, ref, scope: savedScope, id })
      .then((detail) => {
        if (disposed) {
          return
        }
        setRunRow(detail.row)
        setRunView(detail.view)
        setRunLedger(detail.ledger)
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRunViewError(error instanceof Error ? error.message : String(error))
          setRunView(null)
          setRunRow(null)
          setRunLedger(null)
        }
      })
      .finally(() => {
        if (!disposed) {
          setRunViewLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [id, mode, runRefreshRevision, runRowsById, savedScope, selectedRunId])

  const previewText = useMemo(() => {
    if (!draft) {
      return ''
    }
    if (!draft.savedDocument || draft.sourceIsBroken || draft.isNew) {
      return renderNewPipeline(draft.draftDocument)
    }
    const sourceDocumentOption = !PipelineDocumentSchema.safeParse(draft.savedDocument).success
      ? { sourceDocument: draft.savedDocument }
      : {}
    try {
      return applyPipelineEdits(
        draft.savedSourceText,
        diffPipelineDocument(draft.savedDocument, draft.draftDocument),
        sourceDocumentOption
      ).text
    } catch {
      return renderNewPipeline(draft.draftDocument)
    }
  }, [draft])

  const addNode = useCallback(
    (type: NodeType): void => {
      if (readOnly) {
        return
      }
      const store = usePipelineCanvasDraftStore.getState()
      const current = store.drafts[file.id]
      if (!current) {
        return
      }
      const nodeId = nextPipelineNodeId(type, current.draftDocument.nodes)
      store.addNode(file.id, createPipelineNode(type, nodeId, current.draftDocument))
      setSelectedNodeId(nodeId)
    },
    [file.id, readOnly]
  )

  const duplicateToRepo = useCallback(async (): Promise<void> => {
    if (!pipeline || pipeline.scope !== 'builtin' || !draft?.savedDocument) {
      return
    }
    try {
      const existingIds = await listRepoPipelineIds(pipeline.worktreeId, pipeline.ref)
      const newId = nextFreePipelineId(draft.savedDocument.id, existingIds)
      const newName =
        `${draft.savedDocument.name} ${translate('fork.heimdallPipeline.menu.copySuffix', 'copy')}`.slice(
          0,
          120
        )
      const yamlText = copyPipelineSource(draft.savedSourceText, newId, newName)
      const layout = layeredLayout(draft.draftDocument, draft.layout)
      const layoutText = renderPipelineLayoutForDocument(layout, draft.draftDocument)
      await writeRepoPipeline({
        worktreeId: pipeline.worktreeId,
        id: newId,
        yamlText,
        layoutText,
        ownerRef: pipeline.ref
      })
      const opened = openPipelineTab({ scope: 'repo', worktreeId: pipeline.worktreeId, id: newId })
      if (!opened) {
        toast.error(
          translate(
            'fork.heimdallPipeline.error.copyWorkspaceUnavailable',
            'The target workspace is unavailable.'
          )
        )
      }
      await trackRepoCopy(pipeline.worktreeId, newId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [draft, pipeline, trackRepoCopy])

  if (loadError) {
    return (
      <div className="pipeline-canvas__empty" role="alert">
        {loadError}
      </div>
    )
  }
  if (!loaded || !draft) {
    return (
      <div className="pipeline-canvas__empty" role="status">
        {translate('fork.heimdallPipeline.tab.loading', 'Loading pipeline canvas…')}
      </div>
    )
  }

  const selectedNode = draft.draftDocument.nodes.find((node) => node.id === selectedNodeId) ?? null
  const editNode = (originalNodeId: string, node: PipelineNode): void => {
    usePipelineCanvasDraftStore.getState().editNode(file.id, originalNodeId, () => node)
    setSelectedNodeId(node.id)
  }
  const updateDocument = (document: PipelineDocument): void => {
    usePipelineCanvasDraftStore.getState().editDocument(file.id, () => document)
  }
  const validation = draft.validation

  const answerChoice = async (
    command: PipelineChoiceCommand
  ): Promise<WatcherCommandResult | null> => {
    if (!runRow) {
      return null
    }
    return answerPipelineCanvasChoice({ row: runRow, command })
  }
  const refreshRun = (): void => {
    setRunRefreshRevision((revision) => revision + 1)
    void hydrateFleet()
  }

  return (
    <div className="pipeline-canvas" data-pipeline-scope={savedScope}>
      <PipelineCanvasHeader
        name={draft.draftDocument.name}
        dirty={draft.dirty}
        readOnly={readOnly}
        saving={saving}
        scope={savedScope}
        view={view}
        mode={mode}
        runOptions={liveRuns}
        selectedRunId={selectedRunId}
        differsFromSaved={
          mode === 'run' &&
          runView !== null &&
          (draft.savedDocument === null ||
            runView.pin.contentHash !== pipelineContentHash(draft.savedDocument))
        }
        runDisabled={runDisabled}
        onNameChange={(name) => updateDocument({ ...draft.draftDocument, name })}
        onSave={requestSave}
        onDuplicate={() => void duplicateToRepo()}
        onViewChange={setView}
        onModeChange={setMode}
        onRunSelect={setSelectedRunId}
        onRunPipeline={requestRun}
      />
      <PipelineTrackingNotice
        result={trackingResult}
        reincludeAvailable={trackingReincludeAvailable}
        onReinclude={() => void reincludePipelines()}
        onDismiss={dismissTracking}
      />
      {liveRuns.length > 0 ? (
        <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground" role="status">
          {translate(
            'fork.heimdallPipeline.notice.liveRuns',
            '{{count}} live runs use the version they started with',
            { count: liveRuns.length }
          )}
        </p>
      ) : null}
      {draft.banner === 'external-change' ? (
        <div className="pipeline-canvas__alerts">
          <PipelineExternalChangeBanner
            onReload={() => usePipelineCanvasDraftStore.getState().reload(file.id)}
            onKeepMine={() => usePipelineCanvasDraftStore.getState().keepMine(file.id)}
          />
        </div>
      ) : null}
      {mode === 'edit' ? (
        <PipelineValidationList errors={validation} onSelectNode={setSelectedNodeId} />
      ) : null}
      {mode === 'run' ? (
        <div className="p-3">
          {runViewLoading ? (
            <div className="pipeline-canvas__empty" role="status">
              {translate('fork.heimdallPipeline.runGraph.loading', 'Loading pinned run…')}
            </div>
          ) : runViewError ? (
            <div className="pipeline-canvas__empty" role="alert">
              {runViewError}
            </div>
          ) : runView && runRow ? (
            <PipelineRunGraph
              view={runView}
              surface="canvas-run"
              row={runRow}
              ledger={runLedger}
              onAnswer={answerChoice}
              onApprove={(scope) => approvePipelineCanvasAction({ row: runRow, scope })}
              onAnswered={refreshRun}
            />
          ) : (
            <div className="pipeline-canvas__empty" role="status">
              {translate(
                'fork.heimdallPipeline.runGraph.selectRun',
                'Select a live pipeline run to view its pinned graph.'
              )}
            </div>
          )}
        </div>
      ) : view === 'yaml' ? (
        <PipelineYamlPreview text={previewText} />
      ) : (
        <div className="pipeline-canvas__workspace">
          <PipelinePalette readOnly={readOnly} onAddNode={addNode} />
          <PipelineCanvasGraph
            file={file}
            draft={draft}
            selectedNodeId={selectedNodeId}
            readOnly={readOnly}
            onSelectNode={setSelectedNodeId}
            onAddNode={addNode}
          />
          <PipelineInspector
            document={draft.draftDocument}
            selectedNode={selectedNode}
            readOnly={readOnly}
            onDocumentChange={updateDocument}
            onNodeChange={editNode}
            onRemoveNode={(nodeId) => {
              usePipelineCanvasDraftStore.getState().removeNode(file.id, nodeId)
              setSelectedNodeId(null)
            }}
          />
        </div>
      )}
      <PipelineCanvasRunDialogs
        replaceFileOpen={replaceFileDialogOpen}
        onReplaceFileOpenChange={onReplaceFileOpenChange}
        onReplaceFile={() => void performSave(true)}
        saveToChoiceOpen={saveToChoiceOpen}
        onSaveToChoiceOpenChange={onSaveToChoiceOpenChange}
        onChooseSaveScope={(scope) => void chooseSaveScope(scope)}
        unsavedRunOpen={unsavedRunDialogOpen}
        onUnsavedRunOpenChange={setUnsavedRunDialogOpen}
        onSaveAndRun={() => void saveAndRun()}
        saving={saving}
        runSheetOpen={runSheetOpen}
        onRunSheetOpenChange={handleRunSheetOpenChange}
        initialPipelineRef={runSheetInitialRef}
        initialWorktreeId={file.worktreeId}
      />
    </div>
  )
}

export function PipelineCanvas({ file }: { file: OpenFile }): JSX.Element {
  return (
    <ReactFlowProvider>
      <PipelineCanvasBody file={file} />
    </ReactFlowProvider>
  )
}
