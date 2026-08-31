import { describe, expect, it } from 'vitest'
import { normalizeRightSidebarRoute } from '../../../store/right-sidebar-route'

describe('Session Info renderer route integration', () => {
  it('survives route normalization', () => {
    expect(normalizeRightSidebarRoute('session-info')).toEqual({
      rightSidebarTab: 'session-info',
      rightSidebarExplorerView: 'files'
    })
  })
})
