import { describe, expect, it } from 'vitest'
import {
  ledger,
  node,
  projection,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import { describeObjectiveOwnerState } from './owner-adapter-state'

describe('describeObjectiveOwnerState', () => {
  it('keeps the triggering and in-flight nodes while naming omitted canonical node history', () => {
    const historical = Array.from({ length: 40 }, (_, index) =>
      node(`historical-${index}-${'x'.repeat(64)}`, { state: 'succeeded' })
    )
    const current = snapshot(
      projection({
        nodes: [
          ...historical,
          node('trigger-task', {
            state: 'failed',
            dispatchId: 'trigger-dispatch'
          }),
          node('in-flight-task', {
            state: 'dispatched',
            dispatchId: 'in-flight-dispatch'
          })
        ]
      })
    )

    const brief = describeObjectiveOwnerState(current, ledger(), 2_048, {
      deviation: {
        kind: 'node-failed',
        dispatchId: 'trigger-dispatch',
        taskKey: 'trigger-task',
        failureClass: 'criteria',
        summary: 'the triggering task failed'
      }
    })
    const state: {
      nodes: { taskKey: string; state: string }[]
      omissions?: { nodes?: { count: number; reference: string } }
    } = JSON.parse(brief.text)

    expect(Buffer.byteLength(brief.text, 'utf8')).toBeLessThanOrEqual(2_048)
    expect(brief.truncated).toBe(true)
    expect(state.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskKey: 'trigger-task', state: 'failed' }),
        expect.objectContaining({ taskKey: 'in-flight-task', state: 'dispatched' })
      ])
    )
    expect(state.omissions?.nodes).toMatchObject({
      count: expect.any(Number),
      reference: 'snapshot.world.plan.nodes'
    })
    expect(state.omissions?.nodes?.count).toBeGreaterThan(0)
  })
})
