import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceReviewUI } from './workspace-review-ui'

describe('normalizeWorkspaceReviewUI', () => {
  it('defaults malformed and missing durable booleans to false', () => {
    expect(
      normalizeWorkspaceReviewUI({
        hideCompletedReviewWorkspaces: 'yes',
        hidePassingCheckWorkspaces: undefined
      })
    ).toEqual({
      hideCompletedReviewWorkspaces: false,
      hidePassingCheckWorkspaces: false
    })
  })
})
