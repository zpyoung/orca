import { describe, expect, it } from 'vitest'
import {
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import { decidePipelineTick } from './decide'
import { pipelineStopVerdict } from './stop-verdict'

const TRIAGE_PIPELINE = `version: 1
id: triage
name: Triage
nodes:
  - id: classify
    type: agent
    prompt: Classify the issue
    outputs:
      kind:
        type: text
  - id: route
    type: decision
    after: [classify]
    on: $classify.outputs.kind
  - id: fix
    type: agent
    after:
      - node: route
        when: bug
    prompt: Fix the bug
  - id: land
    type: land
    after: [fix]
`

function classifiedRun(kind: string) {
  const payload = pipelinePayload(TRIAGE_PIPELINE)
  const runWorld = world({
    payload,
    facts: { ...world({ payload }).facts, outputs: [nodeOutputs('classify', 0, 0, { kind })] }
  })
  const dispatch = decidePipelineTick(runWorld, emptyLedger()).action
  expect(dispatch?.pipelineNode).toMatchObject({ instanceId: 'classify' })
  if (dispatch === null) {
    throw new Error('Expected the classify dispatch')
  }
  const ledger = emptyLedger([
    attemptEntry(dispatch, 'attempted', 1_010),
    attemptEntry(dispatch, 'settled', 1_020, { effect: 'landed' })
  ])
  return { runWorld, ledger }
}

describe('pipelineStopVerdict Decision branches', () => {
  it('stops with a configuration error when the decided value matches no branch', () => {
    const { runWorld, ledger } = classifiedRun('Bug')

    expect(pipelineStopVerdict(runWorld, ledger)).toEqual({
      id: 'pipeline-configuration-error',
      detail: 'kindPayload.document.nodes.route.on: value "Bug" matches no branch'
    })
  })

  it('keeps running when the decided value matches a branch', () => {
    const { runWorld, ledger } = classifiedRun('bug')

    expect(pipelineStopVerdict(runWorld, ledger)).toBeNull()
    expect(decidePipelineTick(runWorld, ledger).action?.pipelineNode).toMatchObject({
      instanceId: 'fix'
    })
  })
})
