import { describe, expect, it } from 'vitest'
import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  pipelineNodeVisualState,
  pipelineRunEdgeState,
  type PipelineNodeVisualState,
  type PipelineRunEdgeState
} from './pipeline-run-visual-state'

type Status = PipelineRunNodeView['status']
type WaitingFor = PipelineRunNodeView['waitingFor']
type NodeCase = [Status, WaitingFor, PipelineNodeVisualState]
type StatesByWaitingFor = readonly [
  gate: PipelineNodeVisualState,
  choice: PipelineNodeVisualState,
  capabilityApproval: PipelineNodeVisualState,
  owner: PipelineNodeVisualState,
  absentNull: PipelineNodeVisualState,
  absentUndefined: PipelineNodeVisualState
]

function nodeCases(status: Status, states: StatesByWaitingFor): NodeCase[] {
  const [gate, choice, capabilityApproval, owner, absentNull, absentUndefined] = states
  return [
    [status, 'gate', gate],
    [status, 'choice', choice],
    [status, 'capability-approval', capabilityApproval],
    [status, 'owner', owner],
    [status, null, absentNull],
    [status, undefined, absentUndefined]
  ]
}

const NODE_CASES: NodeCase[] = [
  ...nodeCases('failed', ['failed', 'failed', 'failed', 'failed', 'failed', 'failed']),
  ...nodeCases('pending', ['needs-you', 'needs-you', 'needs-you', 'waiting', 'pending', 'pending']),
  ...nodeCases('running', ['needs-you', 'needs-you', 'needs-you', 'running', 'running', 'running']),
  ...nodeCases('waiting', ['needs-you', 'needs-you', 'needs-you', 'waiting', 'waiting', 'waiting']),
  ...nodeCases('done', ['done', 'done', 'done', 'done', 'done', 'done']),
  ...nodeCases('skipped', ['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']),
  ...nodeCases('unverifiable', [
    'needs-you',
    'needs-you',
    'needs-you',
    'waiting',
    'unknown',
    'unknown'
  ]),
  ...nodeCases('unknown', ['needs-you', 'needs-you', 'needs-you', 'waiting', 'unknown', 'unknown'])
]

describe('pipelineNodeVisualState', () => {
  it('covers every status against every waitingFor value', () => {
    expect(NODE_CASES).toHaveLength(8 * 6)
  })

  it.each(NODE_CASES)('status %s with waitingFor %s is %s', (status, waitingFor, expected) => {
    expect(pipelineNodeVisualState({ status, waitingFor })).toBe(expected)
  })

  it('treats an omitted waitingFor key like null', () => {
    expect(pipelineNodeVisualState({ status: 'running' })).toBe('running')
    expect(pipelineNodeVisualState({ status: 'pending' })).toBe('pending')
  })
})

type EdgeCase = [string, PipelineNodeVisualState, PipelineNodeVisualState, PipelineRunEdgeState]

const EDGE_CASES: EdgeCase[] = [
  ['a skipped target wins over a done source', 'done', 'skipped', 'skipped'],
  ['a skipped target from a pending source', 'pending', 'skipped', 'skipped'],
  ['a skipped target from a failed source', 'failed', 'skipped', 'skipped'],
  ['a skipped target from a skipped source', 'skipped', 'skipped', 'skipped'],
  ['done into running is active', 'done', 'running', 'active'],
  ['done into needs-you is active', 'done', 'needs-you', 'active'],
  ['done into waiting is done', 'done', 'waiting', 'done'],
  ['done into done is done', 'done', 'done', 'done'],
  ['done into pending is done', 'done', 'pending', 'done'],
  ['done into failed is done', 'done', 'failed', 'done'],
  ['done into unknown is done', 'done', 'unknown', 'done'],
  ['pending into running is idle', 'pending', 'running', 'idle'],
  ['running into running is idle', 'running', 'running', 'idle'],
  ['needs-you into running is idle', 'needs-you', 'running', 'idle'],
  ['waiting into needs-you is idle', 'waiting', 'needs-you', 'idle'],
  ['failed into pending is idle', 'failed', 'pending', 'idle'],
  ['skipped into done is idle', 'skipped', 'done', 'idle'],
  ['unknown into running is idle', 'unknown', 'running', 'idle']
]

describe('pipelineRunEdgeState', () => {
  it.each(EDGE_CASES)('%s', (_name, source, target, expected) => {
    expect(pipelineRunEdgeState(source, target)).toBe(expected)
  })
})
