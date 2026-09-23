// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  ObjectiveDetail,
  ObjectiveDetailRevision,
  ObjectiveRevisionStatus
} from '../../../shared/fork-heimdall-objective/detail-types'
import { ObjectivePlan } from './ObjectivePlan'

function verdict(
  overrides: Partial<ObjectiveDetail['verdicts'][number]> = {}
): ObjectiveDetail['verdicts'][number] {
  return {
    dispatchId: 'dispatch-1',
    role: 'reviewer',
    verdict: 'approve',
    contentIdentity: 'content-1',
    synthesizedByOwner: false,
    atMs: 1,
    ...overrides
  }
}

function revision(number: number, status: ObjectiveRevisionStatus): ObjectiveDetailRevision {
  return {
    id: `revision-${number}`,
    number,
    status,
    digest: `digest-${number}`,
    createdAtMs: number,
    approvedAtMs: status === 'approved' ? number : null,
    nodeCount: 1
  }
}

function detail(
  revisions: readonly ObjectiveDetailRevision[],
  verdicts: readonly ObjectiveDetail['verdicts'][number][] = [],
  extra: Partial<ObjectiveDetail> = {}
): ObjectiveDetail {
  return {
    contract: {
      objectiveText: 'Ship the thing',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'git',
      writeTerritory: ['src/**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    revisions: [...revisions],
    nodes: revisions.map((entry) => ({
      taskKey: `task-${entry.number}`,
      title: `Task ${entry.number}`,
      revisionId: entry.id,
      orchestrationTaskId: null,
      dispatchId: null,
      state: 'pending' as const,
      criteria: []
    })),
    verdicts: [...verdicts],
    landing: [],
    asOfMs: 1,
    ...extra
  }
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('#objective-plan-title button')
  if (!button) {
    throw new Error('plan heading is not a disclosure button')
  }
  return button
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
})

describe('ObjectivePlan', () => {
  it('collapses an approved plan that is already being implemented', async () => {
    await act(async () => root.render(<ObjectivePlan detail={detail([revision(1, 'approved')])} />))

    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Plan')
    expect(container.textContent).toContain('Revision 1')
  })

  it.each<ObjectiveRevisionStatus>(['draft', 'rejected'])(
    'leaves a %s plan expanded because it still needs the user',
    async (status) => {
      await act(async () => root.render(<ObjectivePlan detail={detail([revision(1, status)])} />))

      expect(trigger().getAttribute('aria-expanded')).toBe('true')
    }
  )

  it('follows the latest revision, not the one the tabs have selected', async () => {
    await act(async () =>
      root.render(
        <ObjectivePlan detail={detail([revision(1, 'superseded'), revision(2, 'approved')])} />
      )
    )

    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the user toggle once a replan lands', async () => {
    const approved = detail([revision(1, 'approved')])
    await act(async () => root.render(<ObjectivePlan detail={approved} />))
    await act(async () => {
      trigger().click()
    })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    await act(async () =>
      root.render(
        <ObjectivePlan detail={detail([revision(1, 'superseded'), revision(2, 'approved')])} />
      )
    )
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('marks a verdict the owner synthesized instead of a real reviewer', async () => {
    await act(async () =>
      root.render(
        <ObjectivePlan
          detail={detail([revision(1, 'draft')], [verdict({ synthesizedByOwner: true })])}
        />
      )
    )

    expect(container.textContent).toContain('Synthesized by owner')
  })

  it('leaves a real reviewer verdict unmarked', async () => {
    await act(async () =>
      root.render(
        <ObjectivePlan
          detail={detail([revision(1, 'draft')], [verdict({ synthesizedByOwner: false })])}
        />
      )
    )

    expect(container.textContent).not.toContain('Synthesized by owner')
  })

  it('shows a node territory and flags an overrun path outside it', async () => {
    const single = detail([revision(1, 'draft')], [], {
      nodes: [
        {
          taskKey: 'task-1',
          title: 'Task 1',
          revisionId: 'revision-1',
          orchestrationTaskId: null,
          dispatchId: null,
          territory: ['src/**'],
          overrunPaths: ['docs/outside.md'],
          state: 'pending',
          criteria: []
        }
      ]
    })
    await act(async () => root.render(<ObjectivePlan detail={single} />))

    expect(container.textContent).toContain('src/**')
    expect(container.textContent).toContain('docs/outside.md')
  })

  it('groups plan lint findings by task and shows plan-level findings separately', async () => {
    const withLint = detail([revision(1, 'draft')], [], {
      planLint: {
        findings: [
          { code: 'missing-territory', taskKey: 'task-1', detail: 'Task 1 has no territory.' },
          { code: 'no-gate-declared', taskKey: null, detail: 'The objective declares no gates.' }
        ],
        truncated: false,
        conflictPairs: [['task-1', 'task-2']],
        criticalPathLength: 2,
        maxWidth: 1
      }
    })
    await act(async () => root.render(<ObjectivePlan detail={withLint} />))

    expect(container.textContent).toContain('Task 1 has no territory.')
    expect(container.textContent).toContain('The objective declares no gates.')
    expect(container.textContent).toContain('task-1 ↔ task-2')
  })

  it('shows an assumption with a verified badge and evidence', async () => {
    const withAssumptions = detail([revision(1, 'draft')], [], {
      assumptions: [
        {
          claim: 'The API is stable',
          dependentTaskKeys: ['task-1'],
          status: 'verified',
          evidence: 'Checked the changelog'
        }
      ]
    })
    await act(async () => root.render(<ObjectivePlan detail={withAssumptions} />))

    expect(container.textContent).toContain('The API is stable')
    expect(container.textContent).toContain('Verified')
    expect(container.textContent).toContain('Checked the changelog')
  })

  it('shows the plan review history', async () => {
    const withReviews = detail([revision(1, 'draft')], [], {
      planReviews: [
        {
          targetKind: 'revision',
          targetId: 'revision-1',
          round: 1,
          verdict: 'revise',
          summary: 'Needs a territory fix',
          createdAtMs: 100
        }
      ]
    })
    await act(async () => root.render(<ObjectivePlan detail={withReviews} />))

    expect(container.textContent).toContain('Needs a territory fix')
    expect(container.textContent).toContain('Revise')
  })

  it('shows a rejected repair patch and its rejection reason', async () => {
    const withPatch = detail([revision(1, 'draft')], [], {
      pendingPatch: {
        id: 'patch-1',
        status: 'rejected',
        rejection: 'Names a frozen task',
        touchedTaskKeys: ['task-2']
      }
    })
    await act(async () => root.render(<ObjectivePlan detail={withPatch} />))

    expect(container.textContent).toContain('Names a frozen task')
    expect(container.textContent).toContain('task-2')
  })

  it('shows a gate result and the no-gate note', async () => {
    const withGate = detail([revision(1, 'draft')], [], {
      gates: [
        {
          name: 'lint',
          command: 'pnpm lint',
          timeoutSeconds: 600,
          lastResult: {
            contentIdentity: 'content-1',
            pass: false,
            exitCode: 1,
            timedOut: false,
            completedAtMs: 100
          }
        }
      ]
    })
    await act(async () => root.render(<ObjectivePlan detail={withGate} />))
    expect(container.textContent).toContain('Failed')

    const withoutGates = detail([revision(1, 'draft')], [], { noGateDeclared: true })
    await act(async () => root.render(<ObjectivePlan detail={withoutGates} />))
    expect(container.textContent).toContain('No objective gate declared.')
  })
})
