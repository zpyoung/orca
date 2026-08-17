// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineCanvasScene, { type PipelineCanvasSceneNode } from './PipelineCanvasScene'

afterEach(() => cleanup())

function node(overrides: Partial<PipelineCanvasSceneNode> & { id: string }): PipelineCanvasSceneNode {
  return {
    title: overrides.id,
    status: 'waiting',
    ...overrides
  }
}

describe('PipelineCanvasScene', () => {
  it.each([
    'waiting',
    'running',
    'retrying',
    'succeeded',
    'failed',
    'not_run',
    'held',
    'interrupted',
    'unknown',
    'some-unrecognized-future-tag'
  ])('renders a distinguishable visual for the %s status tag', (status) => {
    const { container } = render(
      <PipelineCanvasScene nodes={[node({ id: 'n1', status })]} pausing={false} />
    )
    const rendered = container.querySelector('[data-node-id="n1"]')
    expect(rendered).not.toBeNull()
    // Unrecognized tags decode to 'unknown' — the data attribute reflects the decoded state.
    const expectedStatus = status === 'some-unrecognized-future-tag' ? 'unknown' : status
    expect(rendered).toHaveAttribute('data-status', expectedStatus)
  })

  it('never throws when a node carries an unrecognized status tag', () => {
    expect(() =>
      render(<PipelineCanvasScene nodes={[node({ id: 'n1', status: 'some-unrecognized-future-tag' })]} pausing={false} />)
    ).not.toThrow()
  })

  it('updates a node normally on a later render after an unrecognized status tag (AC18: unknown never blocks later updates)', () => {
    const { rerender, container } = render(
      <PipelineCanvasScene nodes={[node({ id: 'test', status: 'some-future-tag' })]} pausing={false} />
    )
    expect(container.querySelector('[data-node-id="test"]')).toHaveAttribute('data-status', 'unknown')

    rerender(<PipelineCanvasScene nodes={[node({ id: 'test', status: 'succeeded' })]} pausing={false} />)
    expect(container.querySelector('[data-node-id="test"]')).toHaveAttribute('data-status', 'succeeded')
  })

  it('shows the attempt counter on a retrying node', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'test', status: 'retrying', attempt: 2, attemptsAllowed: 3 })]}
        pausing={false}
      />
    )
    expect(screen.getByText('attempt 2 of 3')).toBeInTheDocument()
  })

  it('does not show an attempt counter when only one attempt is allowed', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'repro', status: 'running', attempt: 1, attemptsAllowed: 1 })]}
        pausing={false}
      />
    )
    expect(screen.queryByText(/attempt \d+ of \d+/)).not.toBeInTheDocument()
  })

  it('shows the advisory-limit warning badge when breached', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'pr', status: 'running', limitBreached: true, limitMinutes: 10 })]}
        pausing={false}
      />
    )
    expect(screen.getByText('over its 10 min limit')).toBeInTheDocument()
  })

  it('does not show the limit badge when not breached', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'pr', status: 'running', limitBreached: false, limitMinutes: 10 })]}
        pausing={false}
      />
    )
    expect(screen.queryByText(/over its/)).not.toBeInTheDocument()
  })

  it('marks the running node with a pausing annotation when the run is pausing', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'fix', status: 'running' })]}
        pausing={true}
      />
    )
    expect(screen.getByText(/pausing/i)).toBeInTheDocument()
  })

  it('does not show a pausing annotation when the run is not pausing', () => {
    render(
      <PipelineCanvasScene nodes={[node({ id: 'fix', status: 'running' })]} pausing={false} />
    )
    expect(screen.queryByText(/pausing/i)).not.toBeInTheDocument()
  })

  it('shows elapsed time on a running node when an elapsed label is provided', () => {
    render(
      <PipelineCanvasScene
        nodes={[node({ id: 'fix', status: 'running', elapsedLabel: '1m 05s' })]}
        pausing={false}
      />
    )
    expect(screen.getByText('1m 05s')).toBeInTheDocument()
  })

  it('does not show elapsed time when no elapsed label is provided', () => {
    render(<PipelineCanvasScene nodes={[node({ id: 'fix', status: 'running' })]} pausing={false} />)
    expect(screen.queryByText(/^\d+(m \d+)?s$/)).not.toBeInTheDocument()
  })

  it('draws one edge per dependency in a chain', () => {
    const { container } = render(
      <PipelineCanvasScene
        nodes={[
          node({ id: 'repro', status: 'succeeded' }),
          node({ id: 'fix', status: 'succeeded' }),
          node({ id: 'test', status: 'running' })
        ]}
        pausing={false}
      />
    )
    expect(container.querySelectorAll('[data-pipeline-edge]')).toHaveLength(2)
  })

  it('draws edges from real needs data instead of inventing a list-order chain', () => {
    // 'merge' needs both 'a' and 'b'; a sequential-chain fallback would draw a->b
    // and b->merge (2 edges, the wrong ones) instead of a->merge and b->merge.
    const { container } = render(
      <PipelineCanvasScene
        nodes={[
          node({ id: 'a', status: 'succeeded', needs: [] }),
          node({ id: 'b', status: 'succeeded', needs: [] }),
          node({ id: 'merge', status: 'running', needs: ['a', 'b'] })
        ]}
        pausing={false}
      />
    )
    const edgeKeys = Array.from(container.querySelectorAll('[data-pipeline-edge]')).map((el) =>
      el.getAttribute('data-edge')
    )
    expect(edgeKeys.sort()).toEqual(['a->merge', 'b->merge'])
  })

  it('renders titles for every node', () => {
    render(
      <PipelineCanvasScene
        nodes={[
          node({ id: 'repro', title: 'Reproduce', status: 'succeeded' }),
          node({ id: 'fix', title: 'Fix', status: 'running' })
        ]}
        pausing={false}
      />
    )
    expect(screen.getByText('Reproduce')).toBeInTheDocument()
    expect(screen.getByText('Fix')).toBeInTheDocument()
  })

  it('renders identical node positions across unmount and remount for the same topology (AC21: no persisted layout)', () => {
    const nodes = [
      node({ id: 'repro', status: 'succeeded', needs: [] }),
      node({ id: 'fix', status: 'running', needs: ['repro'] })
    ]
    const first = render(<PipelineCanvasScene nodes={nodes} pausing={false} />)
    const firstRect = first.container.querySelector('[data-node-id="fix"] rect')
    const firstPosition = { x: firstRect?.getAttribute('x'), y: firstRect?.getAttribute('y') }
    expect(firstPosition.x).not.toBeNull()
    first.unmount()

    const second = render(
      <PipelineCanvasScene nodes={nodes.map((n) => ({ ...n }))} pausing={false} />
    )
    const secondRect = second.container.querySelector('[data-node-id="fix"] rect')
    expect({ x: secondRect?.getAttribute('x'), y: secondRect?.getAttribute('y') }).toEqual(
      firstPosition
    )
  })
})
