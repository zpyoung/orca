import { describe, expect, it } from 'vitest'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import { pipelinePayload } from '../interpreter-test-harness'
import type { PipelineNodeRunState } from './index'
import { resolvePipelineReadiness } from './decision-rules'

const DECISION_PIPELINE = `version: 1
id: review-flow
name: Review flow
nodes:
  - id: review
    type: agent
    prompt: Review the change
    outputs:
      verdict:
        type: enum
        values: [ok, block]
  - id: decision
    type: decision
    after: [review]
    on: $review.outputs.verdict
  - id: rework
    type: agent
    after:
      - node: decision
        when: block
    prompt: Rework the change
  - id: ship
    type: agent
    after:
      - node: decision
        when: ok
    prompt: Ship the change
  - id: publish
    type: agent
    after: [ship]
    prompt: Publish the change
`

function pendingStates(payload: PipelineEnrollmentPayload) {
  return new Map<string, PipelineNodeRunState>(
    payload.document.nodes.map(
      ({ id }) => [id, { status: 'pending', epoch: 0, attempt: 0 }] as const
    )
  )
}

describe('resolvePipelineReadiness Decision branches', () => {
  it.each([
    { verdict: 'block', rework: 'ready', ship: 'skipped', publish: 'skipped' },
    { verdict: 'ok', rework: 'skipped', ship: 'ready', publish: 'pending' }
  ] as const)(
    'selects only the $verdict branch and propagates skipped edges',
    ({ verdict, rework, ship, publish }) => {
      const payload = pipelinePayload(DECISION_PIPELINE)
      const states = pendingStates(payload)
      states.set('review', {
        status: 'done',
        epoch: 0,
        attempt: 0,
        outputs: { verdict }
      })

      resolvePipelineReadiness(payload.document, states, { review: { verdict } })

      expect(states.get('decision')).toMatchObject({ status: 'done', outputs: { value: verdict } })
      expect(states.get('rework')?.status).toBe(rework)
      expect(states.get('ship')?.status).toBe(ship)
      expect(states.get('publish')?.status).toBe(publish)
    }
  )

  it('does not resolve or skip Decision branches while the upstream result is still running', () => {
    const payload = pipelinePayload(DECISION_PIPELINE)
    const states = pendingStates(payload)
    states.set('review', { status: 'running', epoch: 0, attempt: 0 })

    resolvePipelineReadiness(payload.document, states, {})

    expect(states.get('review')?.status).toBe('running')
    expect(states.get('decision')?.status).toBe('pending')
    expect(states.get('rework')?.status).toBe('pending')
    expect(states.get('ship')?.status).toBe('pending')
    expect(states.get('publish')?.status).toBe('pending')
  })
  it.each([
    { outputType: 'boolean', when: 'true', value: true },
    { outputType: 'boolean', when: 'false', value: false },
    { outputType: 'number', when: '42', value: 42 }
  ] as const)(
    'normalizes native $outputType value $value to its matching edge',
    ({ outputType, when, value }) => {
      const payload = pipelinePayload(`version: 1
id: branch-${outputType}-${when}
name: Branch
nodes:
  - id: source
    type: agent
    prompt: Produce a decision value
    outputs:
      value:
        type: ${outputType}
  - id: decision
    type: decision
    after: [source]
    on: $source.outputs.value
  - id: selected
    type: agent
    after:
      - node: decision
        when: '${when}'
    prompt: Follow the matching branch
`)
      const states = pendingStates(payload)
      states.set('source', {
        status: 'done',
        epoch: 0,
        attempt: 0,
        outputs: { value }
      })

      resolvePipelineReadiness(payload.document, states, { source: { value } })

      expect(states.get('decision')).toMatchObject({
        status: 'done',
        outputs: { value }
      })
      expect(states.get('selected')?.status).toBe('ready')
    }
  )
})
