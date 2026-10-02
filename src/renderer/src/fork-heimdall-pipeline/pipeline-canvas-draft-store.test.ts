import { afterEach, describe, expect, it } from 'vitest'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  usePipelineCanvasDraftStore,
  type PipelineDiskSignature
} from './pipeline-canvas-draft-store'

const filePath = 'heimdall-pipeline://repo/worktree/bugfix'
const context = { workspaceKind: 'git' as const, expectedId: 'bugfix' }
const initialSignature: PipelineDiskSignature = { mtime: 10, sha256: 'initial' }

function document(prompt: string): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes: [{ id: 'agent', type: 'agent', prompt }]
  }
}

function load(
  sourceDocument = document('reproduce the issue'),
  signature = initialSignature
): void {
  usePipelineCanvasDraftStore.getState().load(filePath, {
    sourceText: renderNewPipeline(sourceDocument),
    layout: null,
    signature,
    sourceExists: true,
    expectedId: 'bugfix',
    validationContext: context
  })
}

afterEach(() => {
  usePipelineCanvasDraftStore.getState().remove(filePath)
})

describe('pipeline canvas draft state', () => {
  it('tracks edits and clears the edited marker after saving an invalid graph', () => {
    load()
    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]?.dirty).toBe(false)

    usePipelineCanvasDraftStore
      .getState()
      .editNode(filePath, 'agent', (node) =>
        node.type === 'agent' ? { ...node, prompt: 'fix the reproduction' } : node
      )
    const edited = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(edited?.dirty).toBe(true)
    expect(edited?.validation).toContainEqual(
      expect.objectContaining({ nodeId: 'agent', code: 'missing-field' })
    )

    if (!edited) {
      throw new Error('The loaded pipeline draft was not available.')
    }
    usePipelineCanvasDraftStore
      .getState()
      .markSaved(
        filePath,
        renderNewPipeline(edited.draftDocument),
        { mtime: 20, sha256: 'saved' },
        edited.layout
      )

    const saved = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(saved?.dirty).toBe(false)
    expect(saved?.validation).toContainEqual(
      expect.objectContaining({ nodeId: 'agent', code: 'missing-field' })
    )
  })

  it('silently replaces a clean draft when the disk signature changes', () => {
    load()
    const replacement = document('use the new task')
    usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
      sourceText: renderNewPipeline(replacement),
      layout: null,
      signature: { mtime: 11, sha256: 'external-clean' }
    })

    const draft = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(draft?.draftDocument.nodes[0]).toMatchObject({ prompt: 'use the new task' })
    expect(draft?.banner).toBeNull()
    expect(draft?.dirty).toBe(false)
  })

  it('preserves dirty edits behind an external-change banner until reload is chosen', () => {
    load()
    usePipelineCanvasDraftStore
      .getState()
      .editNode(filePath, 'agent', (node) =>
        node.type === 'agent' ? { ...node, prompt: 'keep this work' } : node
      )
    usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
      sourceText: renderNewPipeline(document('external work')),
      layout: null,
      signature: { mtime: 12, sha256: 'external-dirty' }
    })

    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]).toMatchObject({
      banner: 'external-change',
      dirty: true,
      draftDocument: document('keep this work')
    })

    usePipelineCanvasDraftStore.getState().reload(filePath)

    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]).toMatchObject({
      banner: null,
      dirty: false,
      draftDocument: document('external work')
    })
  })

  it('rebases the save baseline when keeping local edits over an external version', () => {
    load()
    usePipelineCanvasDraftStore
      .getState()
      .editNode(filePath, 'agent', (node) =>
        node.type === 'agent' ? { ...node, prompt: 'keep this work' } : node
      )
    const external = document('external work')
    const signature = { mtime: 12, sha256: 'external-version' }
    usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
      sourceText: renderNewPipeline(external),
      layout: null,
      signature
    })

    usePipelineCanvasDraftStore.getState().keepMine(filePath)

    const draft = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(draft?.savedDocument).toEqual(external)
    expect(draft?.draftDocument).toEqual(document('keep this work'))
    expect(draft?.diskSignature).toEqual(signature)
    expect(draft?.overwriteOnNextSave).toBe(true)
    expect(draft?.isNew).toBe(false)
    expect(draft?.dirty).toBe(true)
    expect(draft?.banner).toBeNull()
  })

  it('ignores the watch echo for the most recently written content', () => {
    load()
    const writtenSha = 'self-written'
    usePipelineCanvasDraftStore.getState().rememberSelfWrite(filePath, writtenSha)

    usePipelineCanvasDraftStore.getState().diskChanged(filePath, {
      sourceText: renderNewPipeline(document('same written content')),
      layout: null,
      signature: { mtime: 99, sha256: writtenSha }
    })

    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]).toMatchObject({
      banner: null,
      dirty: false,
      diskSignature: initialSignature
    })
  })

  it('does not publish draft updates for repeated graph coordinates', () => {
    load()
    const store = usePipelineCanvasDraftStore.getState()
    const originalState = store
    const draft = store.drafts[filePath]
    if (!draft) {
      throw new Error('The loaded pipeline draft was not available.')
    }

    const position = draft.layout.nodes.agent
    if (!position) {
      throw new Error('The loaded pipeline layout did not place the agent node.')
    }
    store.moveNode(filePath, 'agent', position)
    expect(usePipelineCanvasDraftStore.getState()).toBe(originalState)

    const viewport = draft.layout.viewport ?? { x: 0, y: 0, zoom: 1 }
    store.setViewport(filePath, viewport)
    const viewportState = usePipelineCanvasDraftStore.getState()
    store.setViewport(filePath, viewport)
    expect(usePipelineCanvasDraftStore.getState()).toBe(viewportState)

    const movedPosition = { x: position.x + 10, y: position.y + 10 }
    store.moveNode(filePath, 'agent', movedPosition)
    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]?.layout.nodes.agent).toEqual(
      movedPosition
    )

    const movedViewport = { ...viewport, x: viewport.x + 10 }
    store.setViewport(filePath, movedViewport)
    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]?.layout.viewport).toEqual(
      movedViewport
    )
  })

  it('keeps newer edits dirty when an older in-flight save completes', () => {
    load()
    const store = usePipelineCanvasDraftStore.getState()
    store.editNode(filePath, 'agent', (node) =>
      node.type === 'agent' ? { ...node, prompt: 'first saved edit' } : node
    )
    const snapshot = usePipelineCanvasDraftStore.getState().drafts[filePath]
    if (!snapshot) {
      throw new Error('The pipeline draft snapshot was not available.')
    }
    const snapshotDocument = snapshot.draftDocument
    const snapshotLayout = snapshot.layout
    store.editNode(filePath, 'agent', (node) =>
      node.type === 'agent' ? { ...node, prompt: 'newer edit' } : node
    )

    const clean = usePipelineCanvasDraftStore.getState().markSnapshotSaved(filePath, {
      sourceText: renderNewPipeline(snapshotDocument),
      signature: { mtime: 20, sha256: 'first-save' },
      layout: snapshotLayout,
      document: snapshotDocument
    })

    const current = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(clean).toBe(false)
    expect(current?.savedDocument).toEqual(snapshotDocument)
    expect(current?.draftDocument.nodes[0]).toMatchObject({ prompt: 'newer edit' })
    expect(current?.dirty).toBe(true)
  })
})
