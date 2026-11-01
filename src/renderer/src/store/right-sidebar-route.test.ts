import { describe, expect, it } from 'vitest'
import { normalizeRightSidebarRoute } from './right-sidebar-route'

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

  it('preserves well-formed plugin panel tabs', () => {
    expect(normalizeRightSidebarRoute('plugin:samples.my-plugin/dashboard')).toEqual({
      rightSidebarTab: 'plugin:samples.my-plugin/dashboard',
      rightSidebarExplorerView: 'files'
    })
  })

  it('drops a well-formed tab once the installed plugin list proves it is stale', () => {
    expect(
      normalizeRightSidebarRoute('plugin:samples.removed/dashboard', undefined, {
        installedPluginTabKeys: new Set(['plugin:samples.present/dashboard'])
      })
    ).toEqual({
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files'
    })
  })
})
