import { create } from 'zustand'
import type {
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineLayout } from '../../../shared/fork-heimdall-pipeline/layout-schema'
import type {
  PipelineValidationContext,
  PipelineValidationError
} from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import { layeredLayout } from './layered-layout'
import {
  connectPipelineNodes,
  disconnectPipelineNodes,
  editPipelineNodeDocument,
  removePipelineNodeDocument
} from './pipeline-canvas-document-edits'
import {
  createPipelineCanvasDraftFromSource,
  createPipelineCanvasKeepMineState,
  validationForDraft,
  type LoadPipelineDraft
} from './pipeline-canvas-draft-source-state'

export type PipelineDiskSignature = { mtime: number; sha256: string; personalSignature?: string }
export type PipelineExternalDiskState = {
  sourceText: string
  layout: PipelineLayout | null
  signature: PipelineDiskSignature
}
export type PipelineCanvasDraft = {
  savedSourceText: string
  savedDocument: PipelineDocument | null
  savedLayout: PipelineLayout
  draftDocument: PipelineDocument
  layout: PipelineLayout
  dirty: boolean
  diskSignature: PipelineDiskSignature | null
  banner: null | 'external-change'
  overwriteOnNextSave: boolean
  validation: readonly PipelineValidationError[]
  expectedId: string
  validationContext: PipelineValidationContext
  isNew: boolean
  sourceIsBroken: boolean
  draftTouched: boolean
  pendingExternalDiskState: PipelineExternalDiskState | null
  lastSelfWriteSha256: string | null
}

type PipelineCanvasDraftStore = {
  drafts: Record<string, PipelineCanvasDraft>
  load: (filePath: string, input: LoadPipelineDraft) => void
  editNode: (filePath: string, nodeId: string, update: (node: PipelineNode) => PipelineNode) => void
  editDocument: (filePath: string, update: (document: PipelineDocument) => PipelineDocument) => void
  addNode: (filePath: string, node: PipelineNode) => void
  removeNode: (filePath: string, nodeId: string) => void
  connect: (filePath: string, sourceNodeId: string, targetNodeId: string, when?: string) => void
  disconnect: (filePath: string, sourceNodeId: string, targetNodeId: string) => void
  moveNode: (filePath: string, nodeId: string, position: { x: number; y: number }) => void
  setViewport: (filePath: string, viewport: { x: number; y: number; zoom: number }) => void
  markSaved: (
    filePath: string,
    sourceText: string,
    signature: PipelineDiskSignature,
    layout?: PipelineLayout
  ) => void
  markSnapshotSaved: (
    filePath: string,
    snapshot: {
      sourceText: string
      signature: PipelineDiskSignature
      layout: PipelineLayout
      document: PipelineDocument
    }
  ) => boolean
  retargetIdentity: (oldFilePath: string, newFilePath: string, expectedId: string) => boolean
  rememberSelfWrite: (filePath: string, sha256: string) => void
  diskChanged: (filePath: string, input: PipelineExternalDiskState) => void
  reload: (filePath: string) => void
  keepMine: (filePath: string) => void
  remove: (filePath: string) => void
}

export const usePipelineCanvasDraftStore = create<PipelineCanvasDraftStore>()((set, get) => ({
  drafts: {},
  load: (filePath, input) => {
    const draft = createPipelineCanvasDraftFromSource(input)
    set((state) => ({ drafts: { ...state.drafts, [filePath]: draft } }))
  },
  editNode: (filePath, nodeId, update) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    const edited = editPipelineNodeDocument(current.draftDocument, current.layout, nodeId, update)
    if (!edited) {
      return
    }
    const { document: draftDocument, layout } = edited
    const sameDocument = JSON.stringify(draftDocument) === JSON.stringify(current.savedDocument)
    const sameLayout = JSON.stringify(layout.nodes) === JSON.stringify(current.savedLayout.nodes)
    const draftTouched = true
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          layout,
          draftTouched,
          dirty:
            current.isNew || (current.sourceIsBroken ? draftTouched : !sameDocument || !sameLayout),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  editDocument: (filePath, update) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    const draftDocument = update(current.draftDocument)
    const layout = layeredLayout(draftDocument, current.layout)
    const sameDocument = JSON.stringify(draftDocument) === JSON.stringify(current.savedDocument)
    const sameLayout = JSON.stringify(layout.nodes) === JSON.stringify(current.savedLayout.nodes)
    const draftTouched = true
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          layout,
          draftTouched,
          dirty:
            current.isNew || (current.sourceIsBroken ? draftTouched : !sameDocument || !sameLayout),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  addNode: (filePath, node) => {
    const current = get().drafts[filePath]
    if (!current || current.draftDocument.nodes.some((existing) => existing.id === node.id)) {
      return
    }
    const draftDocument = {
      ...current.draftDocument,
      nodes: [...current.draftDocument.nodes, node]
    }
    const layout = layeredLayout(draftDocument, current.layout)
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          layout,
          draftTouched: true,
          dirty:
            current.isNew ||
            current.sourceIsBroken ||
            JSON.stringify(draftDocument) !== JSON.stringify(current.savedDocument) ||
            JSON.stringify(layout.nodes) !== JSON.stringify(current.savedLayout.nodes),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  removeNode: (filePath, nodeId) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    const edited = removePipelineNodeDocument(current.draftDocument, current.layout, nodeId)
    if (!edited) {
      return
    }
    const { document: draftDocument, layout } = edited
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          layout,
          draftTouched: true,
          dirty:
            current.isNew ||
            current.sourceIsBroken ||
            JSON.stringify(draftDocument) !== JSON.stringify(current.savedDocument) ||
            JSON.stringify(layout.nodes) !== JSON.stringify(current.savedLayout.nodes),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  connect: (filePath, sourceNodeId, targetNodeId, when) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    const draftDocument = connectPipelineNodes(
      current.draftDocument,
      sourceNodeId,
      targetNodeId,
      when
    )
    if (!draftDocument) {
      return
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          draftTouched: true,
          dirty:
            current.isNew ||
            current.sourceIsBroken ||
            JSON.stringify(draftDocument) !== JSON.stringify(current.savedDocument),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  disconnect: (filePath, sourceNodeId, targetNodeId) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    const draftDocument = disconnectPipelineNodes(current.draftDocument, sourceNodeId, targetNodeId)
    if (!draftDocument) {
      return
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          draftDocument,
          draftTouched: true,
          dirty:
            current.isNew ||
            current.sourceIsBroken ||
            JSON.stringify(draftDocument) !== JSON.stringify(current.savedDocument),
          validation: validationForDraft(draftDocument, current.validationContext)
        }
      }
    }))
  },
  moveNode: (filePath, nodeId, position) => {
    const current = get().drafts[filePath]
    if (
      !current ||
      !current.draftDocument.nodes.some((node) => node.id === nodeId) ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      return
    }
    const previousPosition = current.layout.nodes[nodeId]
    if (
      previousPosition &&
      previousPosition.x === position.x &&
      previousPosition.y === position.y
    ) {
      return
    }
    const nodes = { ...current.layout.nodes, [nodeId]: position }
    const layout = { ...current.layout, nodes }
    const sameLayout = JSON.stringify(layout.nodes) === JSON.stringify(current.savedLayout.nodes)
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          layout,
          draftTouched: true,
          dirty:
            current.isNew ||
            (current.sourceIsBroken
              ? true
              : JSON.stringify(current.draftDocument) !== JSON.stringify(current.savedDocument) ||
                !sameLayout)
        }
      }
    }))
  },
  setViewport: (filePath, viewport) => {
    const current = get().drafts[filePath]
    if (
      !current ||
      !Number.isFinite(viewport.x) ||
      !Number.isFinite(viewport.y) ||
      !Number.isFinite(viewport.zoom) ||
      viewport.zoom <= 0
    ) {
      return
    }
    const currentViewport = current.layout.viewport
    if (
      currentViewport &&
      currentViewport.x === viewport.x &&
      currentViewport.y === viewport.y &&
      currentViewport.zoom === viewport.zoom
    ) {
      return
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: { ...current, layout: { ...current.layout, viewport } }
      }
    }))
  },
  markSaved: (filePath, sourceText, signature, layout) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    get().markSnapshotSaved(filePath, {
      sourceText,
      signature,
      layout: layout ?? current.layout,
      document: current.draftDocument
    })
  },
  markSnapshotSaved: (filePath, snapshot) => {
    const current = get().drafts[filePath]
    if (!current) {
      return false
    }
    const dirty =
      JSON.stringify(current.draftDocument) !== JSON.stringify(snapshot.document) ||
      JSON.stringify(current.layout.nodes) !== JSON.stringify(snapshot.layout.nodes)
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: {
          ...current,
          savedSourceText: snapshot.sourceText,
          savedDocument: snapshot.document,
          savedLayout: snapshot.layout,
          draftDocument: current.draftDocument,
          layout: current.layout,
          dirty,
          diskSignature: snapshot.signature,
          banner: current.banner,
          overwriteOnNextSave: current.banner ? current.overwriteOnNextSave : false,
          sourceIsBroken: false,
          isNew: false,
          draftTouched: dirty,
          pendingExternalDiskState: current.pendingExternalDiskState,
          validation: validationForDraft(current.draftDocument, current.validationContext)
        }
      }
    }))
    return !dirty && current.banner === null
  },
  retargetIdentity: (oldFilePath, newFilePath, expectedId) => {
    const current = get().drafts[oldFilePath]
    if (!current || current.isNew || (newFilePath !== oldFilePath && get().drafts[newFilePath])) {
      return false
    }
    const validationContext = { ...current.validationContext, expectedId }
    const retargeted: PipelineCanvasDraft = {
      ...current,
      expectedId,
      validationContext,
      validation: validationForDraft(current.draftDocument, validationContext)
    }
    set((state) => {
      const drafts = { ...state.drafts }
      if (newFilePath !== oldFilePath) {
        delete drafts[oldFilePath]
      }
      drafts[newFilePath] = retargeted
      return { drafts }
    })
    return true
  },
  rememberSelfWrite: (filePath, sha256) => {
    const current = get().drafts[filePath]
    if (!current) {
      return
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: { ...current, lastSelfWriteSha256: sha256 }
      }
    }))
  },
  diskChanged: (filePath, input) => {
    const current = get().drafts[filePath]
    if (
      !current ||
      (current.diskSignature?.mtime === input.signature.mtime &&
        current.diskSignature.sha256 === input.signature.sha256 &&
        current.diskSignature.personalSignature === input.signature.personalSignature) ||
      current.lastSelfWriteSha256 === input.signature.sha256
    ) {
      return
    }
    if (current.dirty) {
      set((state) => ({
        drafts: {
          ...state.drafts,
          [filePath]: {
            ...current,
            banner: 'external-change',
            pendingExternalDiskState: input
          }
        }
      }))
      return
    }
    get().load(filePath, {
      sourceText: input.sourceText,
      layout: input.layout,
      signature: input.signature,
      sourceExists: true,
      expectedId: current.expectedId,
      validationContext: current.validationContext
    })
  },
  reload: (filePath) => {
    const current = get().drafts[filePath]
    const external = current?.pendingExternalDiskState
    if (!current || !external) {
      return
    }
    get().load(filePath, {
      sourceText: external.sourceText,
      layout: external.layout,
      signature: external.signature,
      sourceExists: true,
      expectedId: current.expectedId,
      validationContext: current.validationContext
    })
  },
  keepMine: (filePath) => {
    const current = get().drafts[filePath]
    const external = current?.pendingExternalDiskState
    if (!current || !external) {
      return
    }
    set((state) => ({
      drafts: {
        ...state.drafts,
        [filePath]: createPipelineCanvasKeepMineState(current, external)
      }
    }))
  },
  remove: (filePath) => {
    if (!get().drafts[filePath]) {
      return
    }
    set((state) => {
      const drafts = { ...state.drafts }
      delete drafts[filePath]
      return { drafts }
    })
  }
}))
