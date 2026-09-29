import { describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { isServerReportedWorkspaceAbsence, isWorkspaceAbsenceCandidate } from './placement-absence'

describe('Heimdall workspace absence reports', () => {
  it.each(['selector_not_found', 'worktree_not_found', 'worktree_not_found_on_server'])(
    'recognizes the typed %s absence code',
    (code) => {
      expect(isWorkspaceAbsenceCandidate(new OrchestrationError(code, 'unavailable'))).toBe(true)
    }
  )

  it('rejects a transport code even when its message resembles a selector miss', () => {
    expect(
      isWorkspaceAbsenceCandidate(
        new OrchestrationError('transport_unavailable', 'selector_not_found')
      )
    ).toBe(false)
  })

  it('requires the explicit server absence code to bypass an unavailable catalog', () => {
    expect(
      isServerReportedWorkspaceAbsence(
        new OrchestrationError('worktree_not_found_on_server', 'not on server')
      )
    ).toBe(true)
    expect(
      isServerReportedWorkspaceAbsence(new OrchestrationError('worktree_not_found', 'missing'))
    ).toBe(false)
  })
})
