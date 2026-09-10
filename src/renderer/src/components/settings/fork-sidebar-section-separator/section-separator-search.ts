import type { SettingsSearchEntry } from '../settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../settings-search-keywords'

export const getSidebarSectionSeparatorEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate('fork.sidebarSectionSeparator.title', 'Sidebar section separators'),
  description: translate(
    'fork.sidebarSectionSeparator.description',
    'Show divider lines between top-level projects and groups.'
  ),
  keywords: [
    ...translateSearchKeyword('fork.sidebarSectionSeparator.keywordSidebar', 'sidebar'),
    ...translateSearchKeyword('fork.sidebarSectionSeparator.keywordSeparator', 'separator'),
    ...translateSearchKeyword('fork.sidebarSectionSeparator.keywordDivider', 'divider'),
    ...translateSearchKeyword('fork.sidebarSectionSeparator.keywordProject', 'project'),
    ...translateSearchKeyword('fork.sidebarSectionSeparator.keywordGroup', 'group')
  ]
}))
