import { describe, expect, it } from 'vitest'
import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import { parsePipelineNodeEvidenceKey, type PipelineChoice } from '../choice-types'
import { decidePipelineTick } from './decide'
import { derivePipelineRunState } from './run-state'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'

type Verdict = 'approve' | 'revise' | 'escalate'

function loopYaml(tail: string): string {
  return `version: 1
id: loop-repair
name: Loop repair
nodes:
  - id: fix
    type: agent
    prompt: Fix the bug
  - id: review
    type: agent
    after: [fix]
    prompt: Review the fix
    outputs:
      verdict:
        type: verdict
  - id: iteration
    type: loop
    after: [review]
    body: [fix, review]
    until: $review.outputs.verdict
    maxRounds: 3
${tail}`
}

const GATE_TAIL = `  - id: approval
    type: gate
    after: [iteration]
    label: Human review
    sendBackTo: fix
  - id: publish
    type: agent
    after: [approval]
    prompt: Publish the fix
`

const CHECK_TAIL = `  - id: verify
    type: check
    after: [iteration]
    command: npm test
    retry: 1
    onFail:
      sendBackTo: fix
`

// review verdicts are keyed by review epoch; each run reads the one for its current epoch
function pipelineRun(tail: string, verdicts: readonly Verdict[]) {
  const payload = pipelinePayload(loopYaml(tail))
  const runWorld = world({
    payload,
    facts: {
      ...world({ payload }).facts,
      outputs: verdicts.map((verdict, epoch) =>
        nodeOutputs('review', epoch, 0, {
          verdict: {
            verdict,
            objections: [`Objection from round ${epoch + 1}`],
            reason: `Reason from round ${epoch + 1}`
          }
        })
      )
    }
  })
  let ledger: WatcherLedger = emptyLedger()
  let clock = 1_000
  let sequence = 0

  const append = (entry: WatcherLedger['entries'][number]) => {
    ledger = { ...ledger, entries: [...ledger.entries, entry] }
  }
  const next = (): KernelAction => {
    const action = decidePipelineTick(runWorld, ledger).action
    if (action === null) {
      throw new Error('Expected an interpreter action')
    }
    return action
  }
  const record = (action: KernelAction, state: 'attempted' | 'settled', landed = true) => {
    clock += 10
    append(
      attemptEntry(action, state, clock, {
        attemptId: `attempt-${action.evidenceKey}`,
        ...(state === 'settled' ? { effect: landed ? 'landed' : 'not-landed' } : {})
      })
    )
  }
  const run = (expected: { instanceId: string; epoch: number }, landed = true): KernelAction => {
    const action = next()
    expect(action.pipelineNode).toMatchObject(expected)
    record(action, 'attempted')
    record(action, 'settled', landed)
    return action
  }
  const choose = (choice: PipelineChoice, comment?: string) => {
    const offered = next()
    sequence += 1
    append({
      ...answerEvidence(
        {
          actionKind: offered.kind,
          contentIdentity: offered.contentIdentity,
          evidenceKey: offered.evidenceKey
        },
        choice,
        comment === undefined ? {} : { comment }
      ),
      eventId: `answer-${sequence}`
    })
    const control = next()
    expect(control.evidenceKey).toBe(offered.evidenceKey)
    record(control, 'attempted')
    record(control, 'settled')
  }
  const state = () =>
    derivePipelineRunState({
      payload: runWorld.payload,
      ledger,
      facts: runWorld.facts,
      nowMs: runWorld.nowMs
    })

  return { next, run, choose, state, record }
}

function runTwoRounds(driver: ReturnType<typeof pipelineRun>) {
  driver.run({ instanceId: 'fix', epoch: 0 })
  driver.run({ instanceId: 'review', epoch: 0 })
  driver.run({ instanceId: 'fix', epoch: 1 })
  driver.run({ instanceId: 'review', epoch: 1 })
}

describe('send-back after a loop has advanced its body', () => {
  it('re-runs the target with the gate comment after two loop rounds', () => {
    const driver = pipelineRun(GATE_TAIL, ['revise', 'approve'])
    runTwoRounds(driver)
    expect(driver.state().nodes.get('approval')?.status).toBe('ready')

    driver.choose('send-back', 'Handle the null path too')

    const sentBack = driver.state()
    expect(sentBack.nodes.get('fix')).toMatchObject({ status: 'ready', epoch: 2, attempt: 0 })
    expect(sentBack.nodes.get('review')?.epoch).toBe(2)
    expect(sentBack.nodes.get('approval')?.status).toBe('pending')
    const dispatch = driver.next()
    expect(dispatch).toMatchObject({
      kind: 'pipeline-dispatch-agent',
      pipelineNode: { instanceId: 'fix', epoch: 2 },
      spec: expect.stringContaining('## Send-back comment\nHandle the null path too')
    })
    expect(dispatch.spec).not.toContain('## Reviewer objections')
  })

  it('repairs from an onFail.sendBackTo check after two loop rounds', () => {
    const driver = pipelineRun(CHECK_TAIL, ['revise', 'approve'])
    runTwoRounds(driver)

    driver.run({ instanceId: 'verify', epoch: 0 }, false)

    expect(driver.state().nodes.get('fix')).toMatchObject({ status: 'ready', epoch: 2 })
    expect(driver.next().pipelineNode).toMatchObject({ instanceId: 'fix', epoch: 2 })
  })

  it('advances a shared target once when two checks fail against the same output', () => {
    const payload = pipelinePayload(`version: 1
id: twin-checks
name: Twin checks
nodes:
  - id: fix
    type: agent
    prompt: Fix the bug
  - id: lint
    type: check
    after: [fix]
    command: npm run lint
    retry: 1
    onFail:
      sendBackTo: fix
  - id: unit
    type: check
    after: [fix]
    command: npm test
    retry: 1
    onFail:
      sendBackTo: fix
`)
    const runWorld = world({ payload })
    const entries: WatcherLedger['entries'][number][] = []
    const ledger = () => emptyLedger(entries)
    const fix = decidePipelineTick(runWorld, ledger()).action
    if (fix === null) {
      throw new Error('Expected the fix dispatch')
    }
    entries.push(attemptEntry(fix, 'settled', 1_010, { effect: 'landed', attemptId: 'fix-0' }))
    const first = decidePipelineTick(runWorld, ledger()).action
    if (first === null) {
      throw new Error('Expected the first check')
    }
    entries.push(attemptEntry(first, 'attempted', 1_020, { attemptId: 'first-check' }))
    const second = decidePipelineTick(runWorld, ledger()).action
    if (second === null) {
      throw new Error('Expected the second check')
    }
    expect(parsePipelineNodeEvidenceKey(second.evidenceKey)?.instanceId).not.toBe(
      parsePipelineNodeEvidenceKey(first.evidenceKey)?.instanceId
    )
    entries.push(
      attemptEntry(second, 'attempted', 1_030, { attemptId: 'second-check' }),
      attemptEntry(first, 'settled', 1_040, { attemptId: 'first-check', effect: 'not-landed' }),
      attemptEntry(second, 'settled', 1_050, { attemptId: 'second-check', effect: 'not-landed' })
    )

    const state = derivePipelineRunState({
      payload,
      ledger: ledger(),
      facts: runWorld.facts,
      nowMs: runWorld.nowMs
    })
    expect(state.nodes.get('fix')).toMatchObject({ status: 'ready', epoch: 1 })
    expect(state.nodes.get('lint')?.epoch).toBe(1)
    expect(state.nodes.get('unit')?.epoch).toBe(1)
  })

  it('reopens an accepted loop when a send-back re-runs its body', () => {
    const driver = pipelineRun(GATE_TAIL, ['escalate'])
    driver.run({ instanceId: 'fix', epoch: 0 })
    driver.run({ instanceId: 'review', epoch: 0 })
    driver.choose('accept')
    expect(driver.state().nodes.get('iteration')?.status).toBe('done')

    driver.choose('send-back', 'Try a smaller change')

    const sentBack = driver.state()
    expect(sentBack.nodes.get('iteration')?.status).not.toBe('done')
    expect(sentBack.nodes.get('approval')?.status).toBe('pending')
    expect(driver.next().pipelineNode).toMatchObject({ instanceId: 'fix', epoch: 1 })
  })

  it('drops the send-back comment once the loop starts another round', () => {
    const driver = pipelineRun(GATE_TAIL, ['approve', 'revise'])
    driver.run({ instanceId: 'fix', epoch: 0 })
    driver.run({ instanceId: 'review', epoch: 0 })
    driver.choose('send-back', 'Cover the retry path')
    expect(driver.next().spec).toContain('## Send-back comment\nCover the retry path')
    driver.run({ instanceId: 'fix', epoch: 1 })
    driver.run({ instanceId: 'review', epoch: 1 })

    const nextRound = driver.next()
    expect(nextRound.pipelineNode).toMatchObject({ instanceId: 'fix', epoch: 2 })
    expect(nextRound.spec).toContain('## Reviewer objections\nReason: Reason from round 2')
    expect(nextRound.spec).not.toContain('## Send-back comment')
  })
})
