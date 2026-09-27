import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../settings-search-keywords'

export const getForkSessionHandoffSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('components.settings.forkSessionHandoff.searchTitle', 'Session handoff'),
    description: translate(
      'components.settings.forkSessionHandoff.searchDescription',
      'Create reusable instruction templates for continuing work in a new Agent session.'
    ),
    keywords: [
      ...translateSearchKeyword('components.settings.forkSessionHandoff.keywordHandoff', 'handoff'),
      ...translateSearchKeyword('components.settings.forkSessionHandoff.keywordSession', 'session'),
      ...translateSearchKeyword(
        'components.settings.forkSessionHandoff.keywordTemplate',
        'template'
      ),
      ...translateSearchKeyword(
        'components.settings.forkSessionHandoff.keywordReusable',
        'reusable'
      ),
      ...translateSearchKeyword('components.settings.forkSessionHandoff.keywordPrompt', 'prompt'),
      ...translateSearchKeyword(
        'components.settings.forkSessionHandoff.keywordInstructions',
        'instructions'
      )
    ]
  }
])
