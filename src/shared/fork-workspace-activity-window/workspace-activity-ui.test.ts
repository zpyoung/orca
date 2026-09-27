import { describe, expect, it } from 'vitest'
import { mergeWorkspaceActivityUI, normalizeWorkspaceActivityUI } from './workspace-activity-ui'

describe('normalizeWorkspaceActivityUI', () => {
  it('migrates legacy aliases before defaults can mask them', () => {
    expect(
      normalizeWorkspaceActivityUI({
        hideSleepingWorkspaces: true,
        workspaceActivityCustomDays: 14
      })
    ).toEqual({
      workspaceActivityWindow: 'live-only',
      workspaceActivityCustomDays: 14,
      hideSleepingWorkspaces: true
    })
  })

  it('uses the safe default for malformed custom days', () => {
    expect(
      normalizeWorkspaceActivityUI({
        workspaceActivityWindow: 'custom',
        workspaceActivityCustomDays: 0
      }).workspaceActivityCustomDays
    ).toBe(30)
  })

  it('lets a legacy toggle control an existing canonical window and preserves days', () => {
    expect(
      mergeWorkspaceActivityUI(
        { workspaceActivityWindow: 'month', workspaceActivityCustomDays: 21 },
        { hideSleepingWorkspaces: true }
      )
    ).toEqual({
      workspaceActivityWindow: 'live-only',
      workspaceActivityCustomDays: 21,
      hideSleepingWorkspaces: true
    })
    expect(
      mergeWorkspaceActivityUI(
        { workspaceActivityWindow: 'custom', workspaceActivityCustomDays: 21 },
        { workspaceActivityCustomDays: 0 }
      ).workspaceActivityCustomDays
    ).toBe(21)
  })

  it('lets a legacy show-sleeping lift live-only without erasing a time window', () => {
    expect(
      mergeWorkspaceActivityUI(
        { workspaceActivityWindow: 'live-only' },
        { hideSleepingWorkspaces: false }
      ).workspaceActivityWindow
    ).toBe('all')
    // a paired client that only knows the boolean must not reset another client's window
    expect(
      mergeWorkspaceActivityUI(
        { workspaceActivityWindow: 'week' },
        { hideSleepingWorkspaces: false }
      ).workspaceActivityWindow
    ).toBe('week')
    expect(
      mergeWorkspaceActivityUI(
        { workspaceActivityWindow: 'week' },
        { showSleepingWorkspaces: true }
      ).workspaceActivityWindow
    ).toBe('week')
  })
})
