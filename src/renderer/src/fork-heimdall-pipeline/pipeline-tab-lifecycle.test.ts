import { afterEach, describe, expect, it } from 'vitest'
import { disposeClosedEditorTabCaches } from '@/components/editor/closed-editor-tab-disposal'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

function loadDraft(fileId: string): void {
  usePipelineCanvasDraftStore.getState().load(fileId, {
    sourceText: renderNewPipeline({
      version: 1,
      id: 'bugfix',
      name: 'Bugfix',
      inputs: { task: { type: 'text', required: true } },
      nodes: [{ id: 'agent', type: 'agent', prompt: 'repair the issue' }]
    }),
    layout: null,
    signature: { mtime: 1, sha256: 'source' },
    sourceExists: true,
    expectedId: 'bugfix',
    validationContext: { workspaceKind: 'git', expectedId: 'bugfix' }
  })
}

afterEach(() => {
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
})

describe('pipeline tab lifecycle', () => {
  it('removes only a closed owner’s draft and preserves a live pipeline draft', () => {
    const closedFileId = 'pipeline-closed-owner'
    const liveFileId = 'pipeline-live-owner'
    loadDraft(closedFileId)
    loadDraft(liveFileId)
    usePipelineCanvasDraftStore
      .getState()
      .editDocument(liveFileId, (document) => ({ ...document, name: 'Unsaved sibling edit' }))

    disposeClosedEditorTabCaches(
      [
        { id: closedFileId, mode: 'pipeline', filePath: closedFileId },
        { id: liveFileId, mode: 'pipeline', filePath: liveFileId }
      ],
      (file) => file.id === closedFileId
    )

    const drafts = usePipelineCanvasDraftStore.getState().drafts
    expect(drafts[closedFileId]).toBeUndefined()
    expect(drafts[liveFileId]).toMatchObject({
      dirty: true,
      draftDocument: { name: 'Unsaved sibling edit' }
    })
  })
})
