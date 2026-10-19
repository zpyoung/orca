import { describe, expect, it } from 'vitest'
import { getVisibleRightSidebarActivityItems } from '../right-sidebar-activity-visibility'
import { getSessionInfoActivityItem } from './session-info-activity-item'

describe('Session Info activity item', () => {
  it.each([
    { isFolder: false, isFolderWorkspace: false, hasSshHost: false },
    { isFolder: true, isFolderWorkspace: true, hasSshHost: false },
    { isFolder: false, isFolderWorkspace: false, hasSshHost: true }
  ])('stays visible for every workspace kind', (visibility) => {
    expect(
      getVisibleRightSidebarActivityItems([getSessionInfoActivityItem()], visibility)
    ).toHaveLength(1)
  })
})
