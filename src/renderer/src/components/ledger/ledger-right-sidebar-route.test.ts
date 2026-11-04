import { describe, expect, it } from 'vitest'
import { normalizeRightSidebarRoute } from '../../store/right-sidebar-route'

describe('normalizeRightSidebarRoute', () => {
  it('preserves the Ledger route and resets its Explorer subview', () => {
    expect(normalizeRightSidebarRoute('ledger', 'search')).toEqual({
      rightSidebarTab: 'ledger',
      rightSidebarExplorerView: 'files'
    })
  })

  it('restores a serialized Ledger route during hydration', () => {
    const persistedRoute = JSON.parse(
      JSON.stringify({ rightSidebarTab: 'ledger', rightSidebarExplorerView: 'files' })
    )

    expect(
      normalizeRightSidebarRoute(
        persistedRoute.rightSidebarTab,
        persistedRoute.rightSidebarExplorerView,
        { installedPluginTabKeys: new Set() }
      )
    ).toEqual({ rightSidebarTab: 'ledger', rightSidebarExplorerView: 'files' })
  })
})
