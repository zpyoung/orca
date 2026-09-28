import { describe, expect, it } from 'vitest'
import type { ObjectiveAction } from '../../fork-heimdall-objective/objective-actions'
import {
  CONTRACT,
  attempt,
  ledger,
  node,
  projection,
  snapshot,
  workerDone
} from '../../fork-heimdall-objective/decision-test-harness'
import { collectObjectiveJudgmentQuestions } from './objective-question-collection'
import { objectiveRoutingSubject } from './objective-judgment-policy'
import { OBJECTIVE_JUDGMENT_QUESTION_IDS } from './registry'

const activeCapabilities = {
  plan: 'on',
  implement: 'on',
  review: 'on',
  check: 'off',
  land: 'gated'
} as const

function nodeDispatch(taskKey: string, evidenceKey: string): ObjectiveAction {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: `content-${taskKey}`,
    evidenceKey,
    revisionId: 'revision-1',
    taskKey,
    depsOrchestrationIds: []
  }
}

describe('objective judgment question collection', () => {
  it('uses the same role and active scope keys consumed by routing', () => {
    const world = snapshot(projection({ nodes: [node('tiny'), node('crosscut')] }), {
      contract: {
        ...CONTRACT,
        tier: 'full',
        roleAgents: {
          planner: 'codex',
          implementer: 'claude',
          reviewer: 'codex',
          integrator: 'claude'
        }
      },
      capabilities: activeCapabilities
    }).world

    const collected = collectObjectiveJudgmentQuestions(world, ledger())
    expect(
      collected.some(
        (request) =>
          request.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen &&
          request.subjectId === 'worker-state'
      )
    ).toBe(true)
    const requests = collected
      .filter((request) => request.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.agentRouting)
      .map((request) => request.subjectId)
      .sort()

    expect(requests).toEqual(
      [
        objectiveRoutingSubject('planner', 'revision-1'),
        objectiveRoutingSubject('implementer', 'tiny'),
        objectiveRoutingSubject('implementer', 'crosscut'),
        objectiveRoutingSubject('reviewer', 'revision-1'),
        objectiveRoutingSubject('integrator', 'revision-1')
      ].sort()
    )
  })

  it('scores only validated evidence still relevant to the active source', () => {
    const currentAction = nodeDispatch('core', 'revision-1:core')
    const oldAction = nodeDispatch('obsolete', 'revision-1:obsolete')
    const world = snapshot(
      projection({
        nodes: [node('core', { state: 'succeeded', dispatchId: 'dispatch-current' })]
      }),
      {
        capabilities: activeCapabilities,
        judgmentReports: [
          {
            dispatchId: 'dispatch-current',
            role: 'implementer',
            digest: 'digest-current',
            payload: { taskKey: 'core', summary: 'Current report' }
          },
          {
            dispatchId: 'dispatch-old',
            role: 'implementer',
            digest: 'digest-old',
            payload: { taskKey: 'obsolete', summary: 'Old report' }
          }
        ]
      }
    ).world
    const watcherLedger = ledger([
      attempt(oldAction, {
        dispatchId: 'dispatch-old',
        state: 'settled',
        effect: 'landed',
        atMs: 20
      }),
      workerDone('dispatch-old'),
      attempt(currentAction, {
        dispatchId: 'dispatch-current',
        state: 'settled',
        effect: 'landed',
        atMs: 30
      }),
      workerDone('dispatch-current')
    ])

    const subjects = collectObjectiveJudgmentQuestions(world, watcherLedger)
      .filter((request) => request.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality)
      .map((request) => request.subjectId)

    expect(subjects).toEqual(['dispatch-current'])
  })
})
