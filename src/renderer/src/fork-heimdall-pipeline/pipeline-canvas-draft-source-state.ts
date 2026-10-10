import {
  PipelineDocumentSchema,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineLayout } from '../../../shared/fork-heimdall-pipeline/layout-schema'
import {
  validatePipeline,
  type PipelineValidationContext,
  type PipelineValidationError
} from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { createPipelineDocument } from './pipeline-document-factory'
import { layeredLayout } from './layered-layout'
import { recoverPipelineDraftDocument } from './pipeline-canvas-source-recovery'
import type {
  PipelineCanvasDraft,
  PipelineDiskSignature,
  PipelineExternalDiskState
} from './pipeline-canvas-draft-store'

export type LoadPipelineDraft = {
  sourceText: string
  layout: PipelineLayout | null
  signature: PipelineDiskSignature | null
  sourceExists: boolean
  expectedId: string
  validationContext: PipelineValidationContext
}

export function validationForDraft(
  draftDocument: PipelineDocument,
  context: PipelineValidationContext
): readonly PipelineValidationError[] {
  const parsed = PipelineDocumentSchema.safeParse(draftDocument)
  if (parsed.success) {
    return validatePipeline(parsed.data, context)
  }
  return parsed.error.issues.map((issue) => {
    const nodeIndex =
      issue.path[0] === 'nodes' && typeof issue.path[1] === 'number' ? issue.path[1] : null
    return {
      nodeId: nodeIndex === null ? null : (draftDocument.nodes[nodeIndex]?.id ?? null),
      code: 'schema',
      message: issue.message,
      path: issue.path.filter(
        (part): part is string | number => typeof part === 'string' || typeof part === 'number'
      )
    }
  })
}

export function createPipelineCanvasDraftFromSource(input: LoadPipelineDraft): PipelineCanvasDraft {
  const parsed = input.sourceExists ? parsePipelineText(input.sourceText) : null
  const recoveredDocument = parsed?.document ?? recoverPipelineDraftDocument(parsed?.sourceDocument)
  const sourceIsBroken = input.sourceExists && recoveredDocument === null
  const draftDocument: PipelineDocument =
    recoveredDocument ??
    (input.sourceExists
      ? {
          version: 1,
          id: input.expectedId,
          name: input.expectedId,
          inputs: { task: { type: 'text', required: true } },
          nodes: []
        }
      : createPipelineDocument(input.expectedId))
  const layout = layeredLayout(draftDocument, input.layout ?? undefined)
  return {
    savedSourceText: input.sourceText,
    savedDocument: recoveredDocument,
    savedLayout: layout,
    draftDocument,
    layout,
    dirty: !input.sourceExists,
    diskSignature: input.signature,
    banner: null,
    overwriteOnNextSave: false,
    validation:
      sourceIsBroken && input.sourceExists
        ? (parsed?.errors ?? [])
        : validationForDraft(draftDocument, input.validationContext),
    expectedId: input.expectedId,
    validationContext: input.validationContext,
    isNew: !input.sourceExists,
    sourceIsBroken,
    draftTouched: false,
    pendingExternalDiskState: null,
    lastSelfWriteSha256: null
  }
}

export function createPipelineCanvasKeepMineState(
  current: PipelineCanvasDraft,
  external: PipelineExternalDiskState
): PipelineCanvasDraft {
  const parsed = parsePipelineText(external.sourceText)
  const recoveredDocument = parsed.document ?? recoverPipelineDraftDocument(parsed.sourceDocument)
  const baseLayout = layeredLayout(
    recoveredDocument ?? current.draftDocument,
    external.layout ?? undefined
  )
  return {
    ...current,
    savedSourceText: external.sourceText,
    savedDocument: recoveredDocument,
    savedLayout: baseLayout,
    diskSignature: external.signature,
    banner: null,
    overwriteOnNextSave: true,
    sourceIsBroken: recoveredDocument === null,
    isNew: false,
    pendingExternalDiskState: null,
    dirty: true,
    validation:
      recoveredDocument === null
        ? parsed.errors
        : validationForDraft(current.draftDocument, current.validationContext)
  }
}
