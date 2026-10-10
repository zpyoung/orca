import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { PipelineDocumentSchema } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { NodeIdSchema } from '../../../shared/fork-heimdall-pipeline/node-id'
import type { PipelineEnsureTrackedResponse } from '../../../shared/fork-heimdall-pipeline/rpc-schemas'
import {
  applyPipelineEdits,
  PipelineSourceUnparseableError,
  renderNewPipeline
} from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { layeredLayout } from './layered-layout'
import {
  usePipelineCanvasDraftStore,
  type PipelineDiskSignature
} from './pipeline-canvas-draft-store'
import {
  diffPipelineDocument,
  renderPipelineLayoutForDocument
} from './pipeline-canvas-document-edits'
import {
  personalPipelineDiskSignature,
  readPersonalPipeline,
  readRepoPipeline,
  writePersonalPipeline,
  writeRepoPipeline
} from './pipeline-file-io'
import { buildPipelineTabFilePath, retargetPipelineTabIdentity } from './open-pipeline-tab'

export type PipelineTrackingResult = {
  response: PipelineEnsureTrackedResponse | null
  error: string | null
}

export type PipelineSaveResult =
  | {
      status: 'saved'
      clean: boolean
      fileWasRerendered: boolean
      tracking: PipelineTrackingResult | null
      pipelineId: string
      scope: 'repo' | 'user'
    }
  | { status: 'confirmation-required' }
  | { status: 'disk-changed' }
  | { status: 'failed'; message: string }

export type PipelineSaveOptions = {
  allowFileRerender?: boolean
  targetScope?: 'repo' | 'user'
}

const inFlightSaves = new Map<string, Promise<PipelineSaveResult>>()

function sameSignature(
  left: { mtime: number; sha256: string; personalSignature?: string } | null,
  right: { mtime: number; sha256: string; personalSignature?: string } | null
): boolean {
  return (
    left?.mtime === right?.mtime &&
    left?.sha256 === right?.sha256 &&
    left?.personalSignature === right?.personalSignature
  )
}

export async function ensurePipelineTracked(
  worktreeId: string,
  pipelineId: string,
  reinclude = false
): Promise<PipelineTrackingResult> {
  const worktree = useAppStore.getState().getKnownWorktreeById(worktreeId)
  if (!worktree?.repoId) {
    return { response: null, error: null }
  }
  const ensure = window.api.heimdall.pipelineEnsureTracked
  if (!ensure) {
    return {
      response: null,
      error: translate(
        'fork.heimdallPipeline.error.trackingUnavailable',
        'Pipeline tracking is unavailable. Update Orca and try again.'
      )
    }
  }
  try {
    return {
      response: await ensure({
        workspace: { repoId: worktree.repoId, worktreeId },
        pipelineId,
        ...(reinclude ? { reinclude: true } : {})
      }),
      error: null
    }
  } catch (error) {
    return { response: null, error: error instanceof Error ? error.message : String(error) }
  }
}

export function reportPipelineTrackingResult(result: PipelineTrackingResult | null): void {
  if (!result) {
    return
  }
  if (result.error) {
    toast.warning(result.error)
    return
  }
  if (result.response?.status === 'still-ignored') {
    toast.warning(
      result.response.detail ??
        translate('fork.heimdallPipeline.error.stillIgnored', 'Git still ignores this pipeline.')
    )
  } else if (result.response?.status === 'rewrote-orca-line') {
    toast.success(
      translate(
        'fork.heimdallPipeline.notice.tracked',
        'Pipeline files are now included in repository tracking.'
      )
    )
  }
}

async function savePipelineDraftNow(
  filePath: string,
  options: PipelineSaveOptions
): Promise<PipelineSaveResult> {
  const appState = useAppStore.getState()
  const file = appState.openFiles.find((candidate) => candidate.id === filePath)
  if (!file?.pipeline || file.mode !== 'pipeline') {
    return {
      status: 'failed',
      message: translate(
        'fork.heimdallPipeline.error.tabUnavailable',
        'This pipeline tab is no longer open.'
      )
    }
  }
  if (file.pipeline.readOnly || file.pipeline.scope === 'builtin') {
    return {
      status: 'failed',
      message: translate(
        'fork.heimdallPipeline.error.readOnly',
        'Built-in pipelines are read-only.'
      )
    }
  }
  const targetScope = options.targetScope ?? file.pipeline.scope
  if (targetScope !== 'repo' && targetScope !== 'user') {
    return {
      status: 'failed',
      message: translate(
        'fork.heimdallPipeline.error.readOnly',
        'Built-in pipelines are read-only.'
      )
    }
  }
  const draft = usePipelineCanvasDraftStore.getState().drafts[filePath]
  if (!draft) {
    return {
      status: 'failed',
      message: translate(
        'fork.heimdallPipeline.error.draftUnavailable',
        'Pipeline draft state is unavailable.'
      )
    }
  }
  const currentId =
    file.pipeline.scope === 'user' ? file.pipeline.ref.slice('user:'.length) : file.pipeline.ref
  const idText = draft.isNew ? draft.draftDocument.id : currentId
  const parsedId = NodeIdSchema.safeParse(idText)
  if (!parsedId.success) {
    return {
      status: 'failed',
      message: translate('fork.heimdallPipeline.error.invalidId', 'This pipeline id is invalid.')
    }
  }
  const id = parsedId.data
  const destinationFilePath = buildPipelineTabFilePath(targetScope, file.pipeline.worktreeId, id)
  if (
    destinationFilePath !== filePath &&
    appState.openFiles.some((candidate) => candidate.id === destinationFilePath)
  ) {
    return {
      status: 'failed',
      message: translate(
        'fork.heimdallPipeline.error.identityConflict',
        'A pipeline with this id is already open in the selected location.'
      )
    }
  }
  const retargetsFirstSave =
    draft.isNew && (targetScope !== file.pipeline.scope || id !== currentId)

  try {
    const latest =
      targetScope === 'repo'
        ? await readRepoPipeline({ worktreeId: file.pipeline.worktreeId, id })
        : await readPersonalPipeline({ id })
    const latestSignature = latest?.signature ?? null
    if (retargetsFirstSave && latest !== null) {
      return {
        status: 'failed',
        message: translate(
          'fork.heimdallPipeline.error.identityConflict',
          'A pipeline with this id already exists in the selected location.'
        )
      }
    }
    if (!sameSignature(draft.diskSignature, latestSignature)) {
      usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
        sourceText: latest?.yamlText ?? '',
        layout: latest?.layout ?? null,
        signature: latestSignature ?? { mtime: 0, sha256: 'missing' }
      })
      return { status: 'disk-changed' }
    }

    const sourceDocumentOption =
      draft.savedDocument !== null && !PipelineDocumentSchema.safeParse(draft.savedDocument).success
        ? { sourceDocument: draft.savedDocument }
        : {}
    const edits = draft.savedDocument
      ? diffPipelineDocument(draft.savedDocument, draft.draftDocument)
      : []
    let yamlText: string
    let fileWasRerendered = false
    if (draft.isNew) {
      yamlText = renderNewPipeline(draft.draftDocument)
    } else if (options.allowFileRerender && draft.sourceIsBroken) {
      const rendered = applyPipelineEdits(draft.savedSourceText, edits, {
        ...sourceDocumentOption,
        allowFileRerender: true,
        intendedDocument: draft.draftDocument
      })
      yamlText = rendered.text
      fileWasRerendered = rendered.mode === 'file-rerender'
    } else {
      try {
        const rendered = applyPipelineEdits(draft.savedSourceText, edits, sourceDocumentOption)
        if (rendered.mode === 'file-rerender' && !options.allowFileRerender) {
          return { status: 'confirmation-required' }
        }
        yamlText = rendered.text
        fileWasRerendered = rendered.mode === 'file-rerender'
      } catch (error) {
        if (error instanceof PipelineSourceUnparseableError) {
          return { status: 'confirmation-required' }
        }
        throw error
      }
    }

    const layout = layeredLayout(draft.draftDocument, draft.layout)
    const layoutText = renderPipelineLayoutForDocument(layout, draft.draftDocument)
    let signature: PipelineDiskSignature
    if (targetScope === 'repo') {
      signature = await writeRepoPipeline({
        worktreeId: file.pipeline.worktreeId,
        id,
        yamlText,
        layoutText,
        ownerRef: file.pipeline.ref
      })
    } else {
      const expectedSignature =
        latest !== null &&
        'personalSignature' in latest &&
        typeof latest.personalSignature === 'string'
          ? latest.personalSignature
          : undefined
      const result = await writePersonalPipeline({
        id,
        yamlText,
        layoutText,
        ...(expectedSignature === undefined ? {} : { expectedSignature })
      })
      if (result.status === 'conflict') {
        const changed = await readPersonalPipeline({ id })
        usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
          sourceText: changed?.yamlText ?? '',
          layout: changed?.layout ?? null,
          signature: changed?.signature ?? { mtime: 0, sha256: 'missing' }
        })
        return { status: 'disk-changed' }
      }
      signature = personalPipelineDiskSignature(yamlText, layoutText, result.signature)
    }
    const clean = usePipelineCanvasDraftStore.getState().markSnapshotSaved(filePath, {
      document: draft.draftDocument,
      layout,
      sourceText: yamlText,
      signature
    })
    useAppStore.getState().markFileDirty(filePath, !clean)
    const tracking =
      targetScope === 'repo' && draft.isNew
        ? await ensurePipelineTracked(file.pipeline.worktreeId, id)
        : null
    reportPipelineTrackingResult(tracking)
    return {
      status: 'saved',
      clean,
      fileWasRerendered,
      tracking,
      scope: targetScope,
      pipelineId: id
    }
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Save the snapshot currently keyed to an open Pipeline tab, independent of its mounted view. */
export function savePipelineDraft(
  filePath: string,
  options: PipelineSaveOptions = {}
): Promise<PipelineSaveResult> {
  const existing = inFlightSaves.get(filePath)
  if (existing) {
    return existing
  }
  const saving = savePipelineDraftNow(filePath, options)
  let tracked: Promise<PipelineSaveResult>
  tracked = saving.finally(() => {
    if (inFlightSaves.get(filePath) === tracked) {
      inFlightSaves.delete(filePath)
    }
  })
  inFlightSaves.set(filePath, tracked)
  return tracked
}

export async function savePipelineDraftForClose(filePath: string): Promise<boolean> {
  const result = await savePipelineDraft(filePath)
  if (result.status === 'failed') {
    toast.error(result.message)
    return false
  }
  if (result.status === 'confirmation-required') {
    toast.warning(
      translate(
        'fork.heimdallPipeline.notice.openToConfirmReplace',
        'Open the pipeline canvas to confirm replacing YAML comments.'
      )
    )
    return false
  }
  return result.status === 'saved' && result.clean
}
export async function savePipelineDraftForEditor(
  filePath: string,
  trigger: 'autosave' | 'user' = 'user'
): Promise<void> {
  if (trigger === 'autosave') {
    return
  }
  const result = await savePipelineDraft(filePath)
  if (result.status === 'saved') {
    const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === filePath)
    const currentId =
      file?.pipeline?.scope === 'user'
        ? file.pipeline.ref.slice('user:'.length)
        : file?.pipeline?.ref
    if (
      file?.pipeline &&
      (result.scope !== file.pipeline.scope || result.pipelineId !== currentId) &&
      !retargetPipelineTabIdentity(filePath, result.scope, result.pipelineId)
    ) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.tabIdentityUpdateFailed',
          'The pipeline was saved, but this tab could not be moved to its saved identity. Reopen it from Pipelines.'
        )
      )
    }
    if (result.clean) {
      return
    }
  }
  if (result.status === 'failed') {
    throw new Error(result.message)
  }
  if (result.status === 'confirmation-required') {
    throw new Error(
      translate(
        'fork.heimdallPipeline.notice.openToConfirmReplace',
        'Open the pipeline canvas to confirm replacing YAML comments.'
      )
    )
  }
  if (result.status === 'disk-changed') {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.externalChange',
        'This pipeline changed on disk. Resolve the banner before saving.'
      )
    )
  }
  throw new Error(
    translate(
      'fork.heimdallPipeline.error.editedDuringSave',
      'The pipeline changed while saving. Save again to include the latest edits.'
    )
  )
}
