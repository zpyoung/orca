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
  verdicts: readonly ObjectiveDetail['verdicts'][number][] = []
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
    asOfMs: 1
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
})
