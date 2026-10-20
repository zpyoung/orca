// @vitest-environment happy-dom

import type { JSX } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { PipelineInspector } from './PipelineInspector'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

const filePath = 'heimdall-pipeline://repo/worktree/bugfix'

function document(): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix the issue' }]
  }
}

function HarnessInspector(): JSX.Element | null {
  const draft = usePipelineCanvasDraftStore((state) => state.drafts[filePath])
  const node = draft?.draftDocument.nodes[0] ?? null
  if (!draft) {
    return null
  }
  return (
    <PipelineInspector
      document={draft.draftDocument}
      selectedNode={node}
      readOnly={false}
      onDocumentChange={(next) =>
        usePipelineCanvasDraftStore.getState().editDocument(filePath, () => next)
      }
      onNodeChange={(nodeId, next) =>
        usePipelineCanvasDraftStore.getState().editNode(filePath, nodeId, () => next)
      }
      onRemoveNode={(nodeId) => usePipelineCanvasDraftStore.getState().removeNode(filePath, nodeId)}
    />
  )
}

afterEach(() => {
  cleanup()
  usePipelineCanvasDraftStore.getState().remove(filePath)
})

describe('PipelineInspector', () => {
  it('sets an Agent harness and clears its missing-field validation error', () => {
    const initialDocument = document()
    usePipelineCanvasDraftStore.getState().load(filePath, {
      sourceText: renderNewPipeline(initialDocument),
      layout: null,
      signature: { mtime: 1, sha256: 'source' },
      sourceExists: true,
      expectedId: 'bugfix',
      validationContext: { workspaceKind: 'git', expectedId: 'bugfix' }
    })
    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]?.validation).toContainEqual(
      expect.objectContaining({ nodeId: 'fix', code: 'missing-field' })
    )

    render(<HarnessInspector />)
    fireEvent.change(screen.getByLabelText('Harness'), { target: { value: 'codex' } })

    const updated = usePipelineCanvasDraftStore.getState().drafts[filePath]
    expect(updated?.draftDocument.nodes[0]).toMatchObject({ harness: 'codex' })
    expect(
      updated?.validation.some((error) => error.nodeId === 'fix' && error.code === 'missing-field')
    ).toBe(false)
    expect(updated?.dirty).toBe(true)
  })
  it('does not expose editable controls for a built-in pipeline', () => {
    const source = document()
    const rendered = render(
      <PipelineInspector
        document={source}
        selectedNode={source.nodes[0]}
        readOnly
        onDocumentChange={(next) => {
          usePipelineCanvasDraftStore.getState().editDocument(filePath, () => next)
        }}
        onNodeChange={(nodeId, next) => {
          usePipelineCanvasDraftStore.getState().editNode(filePath, nodeId, () => next)
        }}
        onRemoveNode={(nodeId) =>
          usePipelineCanvasDraftStore.getState().removeNode(filePath, nodeId)
        }
      />
    )

    expect(
      rendered.container.querySelector('input, textarea, select, [role="combobox"]')
    ).toBeNull()
  })
})
