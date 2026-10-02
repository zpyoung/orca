// @vitest-environment happy-dom

import { createElement, Fragment, type ReactNode } from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { EditorContent } from '@/components/editor/EditorContent'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

const runtimeFileReads = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))

vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileClient>()),
  readRuntimeFileContent: runtimeFileReads.readRuntimeFileContent
}))

vi.mock('@xyflow/react', () => {
  type FlowProps = { nodes: { id: string }[]; children?: ReactNode; 'aria-label'?: string }

  return {
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    Handle: () => null,
    ReactFlow: ({ nodes, children, 'aria-label': label }: FlowProps) =>
      createElement(
        'div',
        { role: 'application', 'aria-label': label },
        nodes.map((node) => node.id).join(', '),
        children
      ),
    ReactFlowProvider: ({ children }: { children: ReactNode }) =>
      createElement(Fragment, null, children),
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y })
    })
  }
})

afterEach(() => {
  cleanup()
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('EditorContent Pipeline tab route', () => {
  it('loads the built-in canvas surface instead of reading a virtual path as a generic file', async () => {
    const filePath = 'heimdall-pipeline://builtin/worktree/objective'
    const file: OpenFile = {
      id: filePath,
      filePath,
      relativePath: 'objective',
      worktreeId: 'worktree',
      language: 'yaml',
      isDirty: false,
      runtimeEnvironmentId: null,
      readOnly: true,
      pipeline: {
        scope: 'builtin',
        ref: 'builtin:objective',
        worktreeId: 'worktree',
        readOnly: true
      },
      mode: 'pipeline'
    }

    render(
      <EditorContent
        activeFile={file}
        viewStateScopeId={file.id}
        fileContents={{}}
        diffContents={{}}
        editBuffers={{}}
        openFiles={[file]}
        worktreeEntries={[]}
        resolvedLanguage="yaml"
        isMarkdown={false}
        isMermaid={false}
        isCsv={false}
        isNotebook={false}
        mdViewMode="source"
        inlineMarkdownRenderState={null}
        isChangesMode={false}
        sideBySide={false}
        pendingEditorReveal={null}
        handleContentChange={() => undefined}
        handleContentChangeForFile={() => undefined}
        handleDirtyStateHint={() => undefined}
        handleSave={async () => true}
        handleSaveForFile={async () => true}
        reloadContent={() => undefined}
      />
    )

    expect(await screen.findByRole('application', { name: 'Pipeline graph' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate to repo' })).toBeInTheDocument()
    expect(runtimeFileReads.readRuntimeFileContent).not.toHaveBeenCalled()
  })
})
