import type {
  PipelineAuthoringDocument,
  PipelineAuthoringNode
} from './pipeline-authoring-document'

export type PipelineTopKey = 'id' | 'name' | 'description' | 'inputs' | 'capabilities' | 'defaults'
export type SetTopEdit = {
  [Key in PipelineTopKey]: {
    kind: 'set-top'
    key: Key
    value: PipelineAuthoringDocument[Key]
  }
}[PipelineTopKey]

export type PipelineEdit =
  | { kind: 'set-node'; node: PipelineAuthoringNode }
  | { kind: 'delete-node'; nodeId: string }
  | { kind: 'append-node'; node: PipelineAuthoringNode }
  | SetTopEdit

export type PipelineEditMode = 'splice' | 'node-rerender' | 'file-rerender'
export type PipelineEditResult = { text: string; mode: PipelineEditMode }
export type ApplyPipelineEditsOptions = {
  /** Confirms replacing an unspliceable file after the user sees the loss-of-comments notice. */
  allowFileRerender?: boolean
  /** The complete canvas document; required for replacing broken YAML and may be schema-invalid. */
  intendedDocument?: PipelineAuthoringDocument
  /** The current canvas baseline when YAML decodes but fails the canonical document schema. */
  sourceDocument?: PipelineAuthoringDocument
}
