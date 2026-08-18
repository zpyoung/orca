import en from '../components/native-chat/fork-native-chat-width/locales/en.json'
import es from '../components/native-chat/fork-native-chat-width/locales/es.json'
import ja from '../components/native-chat/fork-native-chat-width/locales/ja.json'
import ko from '../components/native-chat/fork-native-chat-width/locales/ko.json'
import zh from '../components/native-chat/fork-native-chat-width/locales/zh.json'

type ForkLocale = 'en' | 'es' | 'ja' | 'ko' | 'zh'
type ForkCatalog = Record<string, unknown>
type ForkCatalogRegistrar = {
  addResourceBundle: (
    language: string,
    namespace: string,
    resources: ForkCatalog,
    deep: boolean,
    overwrite: boolean
  ) => unknown
  on: (
    event: 'loaded',
    listener: (resources: Record<string, Record<string, unknown>>) => void
  ) => unknown
}

const FORK_CATALOGS: Record<ForkLocale, ForkCatalog> = { en, es, ja, ko, zh }

export function registerForkLocalizationCatalogs(i18n: ForkCatalogRegistrar): void {
  i18n.addResourceBundle('en', 'translation', FORK_CATALOGS.en, true, true)
  i18n.on('loaded', (resources) => {
    for (const language of Object.keys(resources)) {
      const catalog = FORK_CATALOGS[language as ForkLocale]
      if (catalog) {
        i18n.addResourceBundle(language, 'translation', catalog, true, true)
      }
    }
  })
}
