// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { ReactFlow } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PIPELINE_NODE_TYPES } from '../../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineNodeVisualState } from '../pipeline-run-visual-state'
import { PipelinePalette } from '../PipelinePalette'
import { PipelineNodeCardFrame } from './PipelineNodeCardFrame'
import { PipelineNodeStatusGlyph } from './PipelineNodeStatusGlyph'
import { PIPELINE_NODE_TYPE_ICONS } from './pipeline-node-type-icons'
import { PIPELINE_FAR_ZOOM_THRESHOLD } from './use-pipeline-far-zoom'

afterEach(() => {
  cleanup()
})

type FrameProps = ComponentProps<typeof PipelineNodeCardFrame>

const BASE_PROPS: FrameProps = {
  typeLabel: 'Agent',
  nodeType: 'agent',
  label: 'Build the feature'
}

function renderFrame(props: Partial<FrameProps> = {}, zoom = 1): HTMLElement {
  const merged: FrameProps = { ...BASE_PROPS, ...props }
  const nodeTypes = { frame: () => <PipelineNodeCardFrame {...merged} /> }
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow
        nodes={[{ id: 'node-1', type: 'frame', position: { x: 0, y: 0 }, data: {} }]}
        edges={[]}
        nodeTypes={nodeTypes}
        defaultViewport={{ x: 0, y: 0, zoom }}
        minZoom={0.2}
      />
    </div>
  )
  const frame = container.querySelector<HTMLElement>('[data-node-type]')
  if (!frame) {
    throw new Error('The card frame did not render')
  }
  return frame
}

describe('PipelineNodeCardFrame', () => {
  it('carries the node type, selection, validity, visual state and zoom level as data attributes', () => {
    const frame = renderFrame({ selected: true, invalid: true, visualState: 'running' })

    expect(frame).toHaveAttribute('data-node-type', 'agent')
    expect(frame).toHaveAttribute('data-selected', 'true')
    expect(frame).toHaveAttribute('data-invalid', 'true')
    expect(frame).toHaveAttribute('data-visual-state', 'running')
    expect(frame).toHaveAttribute('data-lod', 'near')
  })

  it('reads as unselected and valid when the optional props are omitted', () => {
    const frame = renderFrame()

    expect(frame).toHaveAttribute('data-selected', 'false')
    expect(frame).toHaveAttribute('data-invalid', 'false')
    expect(frame).not.toHaveAttribute('data-visual-state')
  })

  it('keeps the fixed handle ids that both edge builders reference', () => {
    const frame = renderFrame()

    const input = frame.querySelector('.react-flow__handle[data-handleid="pipeline-input"]')
    const output = frame.querySelector('.react-flow__handle[data-handleid="pipeline-output"]')
    expect(input).toHaveClass('react-flow__handle-top', 'target')
    expect(output).toHaveClass('react-flow__handle-bottom', 'source')
  })

  it('shows the type label, the full label as a tooltip, and children below the label', () => {
    const frame = renderFrame({ children: <span data-testid="frame-child">Extra detail</span> })

    const label = frame.querySelector('[title="Build the feature"]')
    const child = frame.querySelector('[data-testid="frame-child"]')
    expect(frame).toHaveTextContent('Agent')
    expect(label).toHaveTextContent('Build the feature')
    if (!label || !child) {
      throw new Error('The frame did not render its label and child')
    }
    expect(label.compareDocumentPosition(child)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('hides every icon from assistive technology', () => {
    const frame = renderFrame({ visualState: 'done' })

    const icons = Array.from(frame.querySelectorAll('svg'))
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('collapses to far zoom without changing its text', () => {
    const near = renderFrame({ visualState: 'done', children: <span>Elapsed 2m</span> }, 1)
    const nearText = near.textContent
    cleanup()
    const far = renderFrame({ visualState: 'done', children: <span>Elapsed 2m</span> }, 0.4)

    expect(near).toHaveAttribute('data-lod', 'near')
    expect(far).toHaveAttribute('data-lod', 'far')
    expect(far.textContent).toBe(nearText)
  })

  it('switches to far zoom only strictly below the threshold', () => {
    const atThreshold = renderFrame({}, PIPELINE_FAR_ZOOM_THRESHOLD)
    expect(atThreshold).toHaveAttribute('data-lod', 'near')
    cleanup()
    const belowThreshold = renderFrame({}, PIPELINE_FAR_ZOOM_THRESHOLD - 0.05)
    expect(belowThreshold).toHaveAttribute('data-lod', 'far')
  })

  it('renders the status glyph only when a visual state is given', () => {
    const withState = renderFrame({ visualState: 'failed' })
    expect(withState.querySelector('[data-glyph="failed"]')).not.toBeNull()
    cleanup()
    const withoutState = renderFrame()
    expect(withoutState.querySelector('[data-glyph]')).toBeNull()
  })
})

describe('PipelineNodeStatusGlyph', () => {
  const states: PipelineNodeVisualState[] = [
    'failed',
    'needs-you',
    'running',
    'waiting',
    'pending',
    'done',
    'skipped',
    'unknown'
  ]

  it.each(states)('renders an aria-hidden, text-free glyph for %s', (state) => {
    const { container } = render(<PipelineNodeStatusGlyph state={state} />)

    const glyph = container.querySelector(`[data-glyph="${state}"]`)
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
    expect(glyph?.textContent).toBe('')
  })

  it('reuses the agent spinner for the running state', () => {
    const { container } = render(<PipelineNodeStatusGlyph state="running" />)

    expect(container.querySelector('[data-agent-spinner]')).not.toBeNull()
  })
})

describe('node type icons', () => {
  it('covers every node type plus the unknown type', () => {
    for (const type of [...PIPELINE_NODE_TYPES, 'unknown'] as const) {
      expect(PIPELINE_NODE_TYPE_ICONS[type]).toBeDefined()
    }
  })

  it('shows an aria-hidden icon before each palette button label without changing its behavior', () => {
    const onAddNode = vi.fn()
    const { container } = render(<PipelinePalette readOnly={false} onAddNode={onAddNode} />)

    for (const type of PIPELINE_NODE_TYPES) {
      const button = container.querySelector<HTMLButtonElement>(
        `button[data-pipeline-node-type="${type}"]`
      )
      expect(button).not.toBeNull()
      expect(button?.firstElementChild?.tagName.toLowerCase()).toBe('svg')
      expect(button?.firstElementChild).toHaveAttribute('aria-hidden', 'true')
      expect(button?.textContent?.trim()).not.toBe('')
      expect(button).toHaveAttribute('draggable', 'true')
    }
    container.querySelector<HTMLButtonElement>('button[data-pipeline-node-type="gate"]')?.click()
    expect(onAddNode).toHaveBeenCalledWith('gate')
  })
})
