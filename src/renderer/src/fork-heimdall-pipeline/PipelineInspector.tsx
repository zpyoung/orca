import type { JSX } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  JsonField,
  PipelineNodeInspectorFields,
  TextField,
  updateDocumentJson,
  updateNodeJson
} from './pipeline-node-inspector-fields'
import { PipelineNodeInspectorCompositeFields } from './pipeline-node-inspector-composite-fields'
import { getPipelineNodeTypeLabel } from './pipeline-node-views/PipelineNodeCard'

export function PipelineInspector({
  document,
  selectedNode,
  readOnly,
  onDocumentChange,
  onNodeChange,
  onRemoveNode
}: {
  document: PipelineDocument
  selectedNode: PipelineNode | null
  readOnly: boolean
  onDocumentChange: (document: PipelineDocument) => void
  onNodeChange: (originalNodeId: string, node: PipelineNode) => void
  onRemoveNode: (nodeId: string) => void
}): JSX.Element {
  const panelLabel = translate('fork.heimdallPipeline.inspector.title', 'Inspector')
  if (readOnly) {
    return (
      <aside className="pipeline-inspector scrollbar-sleek" aria-label={panelLabel}>
        <h2 className="pipeline-inspector__heading">{panelLabel}</h2>
        <p className="text-sm text-muted-foreground">
          {selectedNode
            ? translate(
                'fork.heimdallPipeline.inspector.builtinNode',
                'Built-in pipeline nodes are read-only.'
              )
            : translate(
                'fork.heimdallPipeline.inspector.builtinDocument',
                'Duplicate this built-in to edit its graph.'
              )}
        </p>
      </aside>
    )
  }

  if (!selectedNode) {
    return (
      <aside className="pipeline-inspector scrollbar-sleek" aria-label={panelLabel}>
        <h2 className="pipeline-inspector__heading">
          {translate('fork.heimdallPipeline.inspector.pipeline', 'Pipeline')}
        </h2>
        <div className="pipeline-inspector__fields scrollbar-sleek">
          <TextField
            label={translate('fork.heimdallPipeline.inspector.id', 'Pipeline id')}
            value={document.id}
            onChange={(id) => onDocumentChange({ ...document, id })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.name', 'Name')}
            value={document.name}
            onChange={(name) => onDocumentChange({ ...document, name })}
          />
          <TextField
            label={translate('fork.heimdallPipeline.inspector.description', 'Description')}
            value={document.description ?? ''}
            multiline
            onChange={(description) =>
              onDocumentChange({ ...document, description: description || undefined })
            }
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.inputs', 'Inputs')}
            value={document.inputs}
            onChange={(value) => updateDocumentJson(document, 'inputs', value, onDocumentChange)}
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.capabilities', 'Capability requests')}
            value={document.capabilities ?? {}}
            onChange={(value) =>
              updateDocumentJson(document, 'capabilities', value, onDocumentChange)
            }
          />
          <JsonField
            label={translate('fork.heimdallPipeline.inspector.defaults', 'Defaults')}
            value={document.defaults ?? {}}
            onChange={(value) => updateDocumentJson(document, 'defaults', value, onDocumentChange)}
          />
        </div>
      </aside>
    )
  }

  const updateJson = (key: string, value: unknown): boolean =>
    updateNodeJson(document, selectedNode, key, value, onDocumentChange)
  const heading = selectedNode.label?.trim() || selectedNode.id
  return (
    <aside className="pipeline-inspector scrollbar-sleek" aria-label={panelLabel}>
      <div className="pipeline-inspector__heading-row">
        <div className="min-w-0">
          <h2 className="pipeline-inspector__heading">{heading}</h2>
          <p className="text-xs text-muted-foreground">{selectedNode.type}</p>
        </div>
        <Button
          variant="destructive"
          size="icon-sm"
          aria-label={translate('fork.heimdallPipeline.inspector.removeNode', 'Remove node')}
          onClick={() => onRemoveNode(selectedNode.id)}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="pipeline-inspector__fields scrollbar-sleek">
        <TextField
          label={translate('fork.heimdallPipeline.inspector.nodeId', 'Node id')}
          value={selectedNode.id}
          onChange={(id) => onNodeChange(selectedNode.id, { ...selectedNode, id })}
        />
        <TextField
          label={translate('fork.heimdallPipeline.inspector.nodeLabel', 'Label')}
          value={selectedNode.label ?? ''}
          onChange={(label) => {
            if (selectedNode.type === 'gate') {
              onNodeChange(selectedNode.id, { ...selectedNode, label })
            } else {
              onNodeChange(selectedNode.id, { ...selectedNode, label: label || undefined })
            }
          }}
        />
        <JsonField
          label={translate('fork.heimdallPipeline.inspector.after', 'After edges')}
          value={selectedNode.after ?? []}
          onChange={(value) => updateJson('after', value)}
        />
        <p className="text-xs text-muted-foreground">
          {getPipelineNodeTypeLabel(selectedNode.type)}
        </p>
        {selectedNode.type === 'swarm' ||
        selectedNode.type === 'merge' ||
        selectedNode.type === 'objective' ||
        selectedNode.type === 'pr-sitter' ? (
          <PipelineNodeInspectorCompositeFields
            document={document}
            node={selectedNode}
            onNodeChange={onNodeChange}
            onDocumentChange={onDocumentChange}
          />
        ) : (
          <PipelineNodeInspectorFields
            document={document}
            node={selectedNode}
            onNodeChange={onNodeChange}
            onDocumentChange={onDocumentChange}
          />
        )}
      </div>
    </aside>
  )
}
