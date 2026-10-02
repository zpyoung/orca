import { NodeIdSchema } from '../../../shared/fork-heimdall-pipeline/node-id'
import { useAppStore } from '@/store'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import { watchPipelineTabClose } from './pipeline-tab-lifecycle'

export type OpenPipelineScope = 'repo' | 'builtin' | 'user'

export type OpenPipelineTabState = {
  scope: OpenPipelineScope
  ref: string
  worktreeId: string
  readOnly: boolean
}

export function buildPipelineTabFilePath(
  scope: OpenPipelineScope,
  worktreeId: string,
  id: string
): string {
  const parsedId = NodeIdSchema.parse(id)
  return `heimdall-pipeline://${scope}/${encodeURIComponent(worktreeId)}/${parsedId}`
}

export function openPipelineTab({
  scope,
  worktreeId,
  id
}: {
  scope: OpenPipelineScope
  worktreeId: string
  id: string
}): string | null {
  if (activateAndRevealWorkspace(worktreeId) === false) {
    return null
  }
  const state = useAppStore.getState()
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const pipeline: OpenPipelineTabState = {
    scope,
    ref: scope === 'builtin' ? `builtin:${id}` : scope === 'user' ? `user:${id}` : id,
    worktreeId,
    readOnly: scope === 'builtin'
  }
  const filePath = buildPipelineTabFilePath(scope, worktreeId, id)
  const fileId = state.openFile(
    {
      filePath,
      relativePath: id,
      worktreeId,
      language: 'yaml',
      runtimeEnvironmentId,
      operationProvenance: captureEditorFileOperationProvenance(
        state,
        worktreeId,
        runtimeEnvironmentId,
        true
      ),
      ...(scope === 'builtin' ? { readOnly: true } : {}),
      pipeline,
      mode: 'pipeline'
    },
    { focusEditor: true }
  )
  watchPipelineTabClose(fileId)
  return fileId
}

/** Retargets a saved first-save draft through the normal virtual-tab open/close path. */
export function retargetPipelineTabIdentity(
  fileId: string,
  scope: 'repo' | 'user',
  id: string
): boolean {
  const state = useAppStore.getState()
  const current = state.openFiles.find((file) => file.id === fileId)
  if (!current?.pipeline || current.pipeline.scope === 'builtin') {
    return false
  }
  const currentId =
    current.pipeline.scope === 'user'
      ? current.pipeline.ref.slice('user:'.length)
      : current.pipeline.ref
  if (current.pipeline.scope === scope && currentId === id) {
    return true
  }
  const targetFilePath = buildPipelineTabFilePath(scope, current.pipeline.worktreeId, id)
  if (state.openFiles.some((file) => file.id === targetFilePath)) {
    return false
  }
  const openedFileId = openPipelineTab({
    scope,
    worktreeId: current.pipeline.worktreeId,
    id
  })
  if (!openedFileId) {
    return false
  }
  const drafts = usePipelineCanvasDraftStore.getState()
  if (!drafts.retargetIdentity(fileId, openedFileId, id)) {
    useAppStore.getState().closeFile(openedFileId)
    return false
  }
  const retargetedDraft = usePipelineCanvasDraftStore.getState().drafts[openedFileId]
  if (retargetedDraft) {
    useAppStore.getState().markFileDirty(openedFileId, retargetedDraft.dirty)
  }
  useAppStore.getState().closeFile(fileId)
  return true
}
