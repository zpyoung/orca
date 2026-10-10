// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import {
  getBezierPath,
  Position,
  ReactFlowProvider,
  useStoreApi,
  type Edge,
  type EdgeProps
} from '@xyflow/react'
import { useEffect, useRef, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  PipelineRunViewSchema,
  type PipelineRunNodeView,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  buildEditFlowEdges,
  buildRunFlowEdges,
  pipelineEdgeTypes,
  type PipelineFlowEdgeData
} from './PipelineFlowEdge'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function agent(id: string, after?: PipelineDocument['nodes'][number]['after']) {
  return {
    id,
    type: 'agent' as const,
    prompt: 'Do the work',
    ...(after === undefined ? {} : { after })
  }
}

describe('buildEditFlowEdges', () => {
  const document: PipelineDocument = {
    version: 1,
    id: 'demo',
    name: 'Demo',
    inputs: {},
    nodes: [
      agent('a'),
      agent('b', ['a']),
      agent('c', ['a', { node: 'b', when: 'tests pass' }]),
      agent('d')
    ]
  }

  it('emits one pipeline-typed edge per dependency with the existing ids and handles', () => {
    const edges = buildEditFlowEdges(document)

    expect(edges.map((edge) => edge.id)).toEqual(['a:b:0', 'a:c:0', 'b:c:1'])
    for (const edge of edges) {
      expect(edge).toMatchObject({
        type: 'pipeline',
        sourceHandle: 'pipeline-output',
        targetHandle: 'pipeline-input'
      })
    }
    expect(edges[0]).toMatchObject({ source: 'a', target: 'b' })
    expect(edges[2]).toMatchObject({ source: 'b', target: 'c' })
  })

  it('carries a when value as the condition and leaves plain dependencies unconditional', () => {
    const edges = buildEditFlowEdges(document)

    expect(edges[0]?.data?.condition).toBeUndefined()
    expect(edges[2]?.data?.condition).toBe('tests pass')
  })

  it('never sets the React Flow label prop and has no run state', () => {
    for (const edge of buildEditFlowEdges(document)) {
      expect(edge.label).toBeUndefined()
      expect(edge.data?.runState).toBeUndefined()
    }
  })

  it('returns no edges for a document without dependencies', () => {
    expect(buildEditFlowEdges({ ...document, nodes: [agent('only')] })).toEqual([])
  })
})

function runNode(
  nodeId: string,
  status: PipelineRunNodeView['status'],
  extra: Partial<PipelineRunNodeView> = {}
): PipelineRunNodeView {
  return {
    instanceId: nodeId,
    nodeId,
    type: 'agent',
    label: nodeId,
    status,
    waitingFor: null,
    epoch: 0,
    attempt: 1,
    turns: 0,
    ...extra
  }
}

function makeView(
  nodes: readonly PipelineRunNodeView[],
  edges: readonly { from: string; to: string; when?: string }[]
): PipelineRunView {
  return PipelineRunViewSchema.parse({
    watcherId: 'watcher-1',
    kind: 'pipeline',
    pin: {
      ref: 'repo:demo',
      scope: 'repo',
      id: 'demo',
      contentHash: `sha256:${'1'.repeat(64)}`,
      documentVersion: 1,
      runNumber: 1,
      label: 'Demo v1'
    },
    document: {
      version: 1,
      id: 'demo',
      name: 'Demo',
      inputs: {},
      nodes: [...new Set(nodes.map((node) => node.nodeId))].map((id) => agent(id))
    },
    nodes,
    edges,
    asOfMs: 1_000
  })
}

describe('buildRunFlowEdges', () => {
  const nodes = [
    runNode('plan', 'done'),
    runNode('build', 'running'),
    runNode('docs', 'done'),
    runNode('release', 'skipped'),
    runNode('review', 'pending'),
    runNode('fan', 'done'),
    runNode('fan', 'running', { instanceId: 'fan[t1]', parentInstanceId: 'fan', taskId: 't1' })
  ]
  const view = makeView(nodes, [
    { from: 'ghost', to: 'plan' },
    { from: 'plan', to: 'build' },
    { from: 'plan', to: 'docs' },
    { from: 'docs', to: 'release' },
    { from: 'plan', to: 'review', when: 'tests pass' },
    { from: 'fan', to: 'review' }
  ])
  const visible = new Set(nodes.map((node) => node.instanceId))

  it('keeps the existing ids, handles, and type, indexed by position in the view', () => {
    const edges = buildRunFlowEdges(view, visible)

    expect(edges.map((edge) => edge.id)).toEqual([
      'plan:build:1',
      'plan:docs:2',
      'docs:release:3',
      'plan:review:4',
      'fan:review:5'
    ])
    for (const edge of edges) {
      expect(edge).toMatchObject({
        type: 'pipeline',
        sourceHandle: 'pipeline-output',
        targetHandle: 'pipeline-input'
      })
      expect(edge.label).toBeUndefined()
    }
  })

  it('derives the run state from the visual state of both endpoints', () => {
    const states = Object.fromEntries(
      buildRunFlowEdges(view, visible).map((edge) => [edge.id, edge.data?.runState])
    )

    expect(states['plan:build:1']).toBe('active')
    expect(states['plan:docs:2']).toBe('done')
    expect(states['docs:release:3']).toBe('skipped')
    expect(states['plan:review:4']).toBe('done')
  })

  it('carries a conditional edge when value as the condition', () => {
    const edges = buildRunFlowEdges(view, visible)

    expect(edges.find((edge) => edge.id === 'plan:review:4')?.data?.condition).toBe('tests pass')
    expect(edges.find((edge) => edge.id === 'plan:build:1')?.data?.condition).toBeUndefined()
  })

  it('anchors edges on the root instance, not a swarm child instance', () => {
    const edge = buildRunFlowEdges(view, visible).find(
      (candidate) => candidate.id === 'fan:review:5'
    )

    expect(edge).toMatchObject({ source: 'fan', target: 'review' })
    expect(edge?.data?.runState).toBe('done')
  })

  it('drops edges whose endpoints are unknown or not visible', () => {
    const withoutBuild = new Set([...visible].filter((id) => id !== 'build'))
    const ids = buildRunFlowEdges(view, withoutBuild).map((edge) => edge.id)

    expect(ids).not.toContain('plan:build:1')
    expect(ids).not.toContain('ghost:plan:0')
    expect(ids).toContain('plan:docs:2')
  })
})

function edgeProps(data?: PipelineFlowEdgeData): EdgeProps<Edge<PipelineFlowEdgeData>> {
  return {
    id: 'a:b:0',
    source: 'a',
    target: 'b',
    sourceX: 10,
    sourceY: 20,
    targetX: 200,
    targetY: 180,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    ...(data === undefined ? {} : { data })
  }
}

function EdgeHarness({ props }: { props: EdgeProps<Edge<PipelineFlowEdgeData>> }): JSX.Element {
  const store = useStoreApi()
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    store.setState({ domNode: hostRef.current })
  }, [store])
  const PipelineEdge = pipelineEdgeTypes.pipeline
  return (
    <div ref={hostRef}>
      <div className="react-flow__edgelabel-renderer" data-testid="label-layer" />
      <svg>
        <PipelineEdge {...props} />
      </svg>
    </div>
  )
}

function renderEdge(data?: PipelineFlowEdgeData): ReturnType<typeof render> {
  return render(
    <ReactFlowProvider>
      <EdgeHarness props={edgeProps(data)} />
    </ReactFlowProvider>
  )
}

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
}

describe('PipelineFlowEdge', () => {
  it('draws a bezier path between the endpoints', () => {
    const { container } = renderEdge()
    const [expected] = getBezierPath({
      sourceX: 10,
      sourceY: 20,
      targetX: 200,
      targetY: 180,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })

    expect(container.querySelector('path.pipeline-flow-edge__path')).toHaveAttribute('d', expected)
  })

  it('marks a plain edge as unconditional and draws no label', () => {
    const { container, getByTestId } = renderEdge()

    const path = container.querySelector('path.pipeline-flow-edge__path')
    expect(path).toHaveAttribute('data-conditional', 'false')
    expect(path).not.toHaveAttribute('data-run-state')
    expect(getByTestId('label-layer')).toBeEmptyDOMElement()
  })

  it('marks a conditional edge for dashing and labels it with the condition text', () => {
    const { container, getByTestId } = renderEdge({ condition: 'tests pass' })

    expect(container.querySelector('path.pipeline-flow-edge__path')).toHaveAttribute(
      'data-conditional',
      'true'
    )
    const label = getByTestId('label-layer').querySelector('.pipeline-flow-edge__label')
    expect(label).toHaveTextContent('tests pass')
  })

  it('renders the condition as text, never as markup', () => {
    const condition = '<img src="x" onerror="alert(1)"> & <b>bold</b>'
    const { getByTestId } = renderEdge({ condition })

    const label = getByTestId('label-layer').querySelector('.pipeline-flow-edge__label')
    expect(label?.textContent).toBe(condition)
    expect(label?.querySelector('img, b')).toBeNull()
  })

  it('carries the run state on the path', () => {
    stubReducedMotion(false)
    for (const runState of ['idle', 'active', 'done', 'skipped'] as const) {
      const { container, unmount } = renderEdge({ runState })

      expect(container.querySelector('path.pipeline-flow-edge__path')).toHaveAttribute(
        'data-run-state',
        runState
      )
      unmount()
    }
  })

  it('sends a spark along the path of an active edge', () => {
    stubReducedMotion(false)
    const { container } = renderEdge({ runState: 'active' })

    const spark = container.querySelector('circle.pipeline-flow-edge__spark')
    expect(spark).not.toBeNull()
    const motion = spark?.querySelector('animateMotion')
    expect(motion).toHaveAttribute('repeatCount', 'indefinite')
    expect(motion?.getAttribute('path')).toBe(
      container.querySelector('path.pipeline-flow-edge__path')?.getAttribute('d')
    )
  })

  it('draws no spark on an edge that is not active', () => {
    stubReducedMotion(false)
    for (const runState of ['idle', 'done', 'skipped'] as const) {
      const { container, unmount } = renderEdge({ runState })

      expect(container.querySelector('.pipeline-flow-edge__spark')).toBeNull()
      unmount()
    }
  })

  it('draws no spark when reduced motion is requested', () => {
    stubReducedMotion(true)
    const { container } = renderEdge({ runState: 'active' })

    expect(container.querySelector('path.pipeline-flow-edge__path')).toHaveAttribute(
      'data-run-state',
      'active'
    )
    expect(container.querySelector('.pipeline-flow-edge__spark')).toBeNull()
  })
})
