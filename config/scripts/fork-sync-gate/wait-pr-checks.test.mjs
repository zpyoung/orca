import { describe, expect, it } from 'vitest'
import { classifyRollup } from './wait-pr-checks.mjs'

function check(name, workflowName, conclusion) {
  return {
    __typename: 'CheckRun',
    name,
    workflowName,
    status: conclusion ? 'COMPLETED' : 'IN_PROGRESS',
    conclusion: conclusion ?? '',
    detailsUrl: `https://example.test/${name}`
  }
}

describe('classifyRollup', () => {
  it('stays pending until the PR Checks gate settles', () => {
    expect(
      classifyRollup([
        check('lint', 'PR Checks', 'SUCCESS'),
        check('PR checks passed', 'PR Checks')
      ]).gate
    ).toBe('pending')
  })

  it('reports a failed pr.yml job as gating before the gate itself settles', () => {
    const status = classifyRollup([
      check('fork ownership guard', 'PR Checks', 'FAILURE'),
      check('PR checks passed', 'PR Checks')
    ])
    expect(status.gatingFailures.map((failed) => failed.name)).toEqual(['fork ownership guard'])
  })

  it('treats other workflows as advisory, whatever their state', () => {
    // benchmark and SSH-host workflows ran on every sync PR without being part of verify
    const status = classifyRollup([
      check('PR checks passed', 'PR Checks', 'SUCCESS'),
      check('compilers', 'Preflight benchmark'),
      check('updater', 'Updater', 'FAILURE'),
      { __typename: 'StatusContext', context: 'external', state: 'PENDING', targetUrl: '' }
    ])
    expect(status.gate).toBe('success')
    expect(status.gatingFailures).toEqual([])
    expect(status.advisoryFailures.map((failed) => failed.name)).toEqual(['updater'])
    expect(status.advisoryPending.map((pending) => pending.name)).toEqual(['compilers', 'external'])
  })

  it('counts a cancelled gate as a failure', () => {
    expect(classifyRollup([check('PR checks passed', 'PR Checks', 'CANCELLED')]).gate).toBe(
      'failure'
    )
  })
})
