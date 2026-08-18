import relayZH from '../components/native-chat/fork-native-chat-relay/locales/zh.json'
import relayKO from '../components/native-chat/fork-native-chat-relay/locales/ko.json'
import relayJA from '../components/native-chat/fork-native-chat-relay/locales/ja.json'
import relayES from '../components/native-chat/fork-native-chat-relay/locales/es.json'
import relayEN from '../components/native-chat/fork-native-chat-relay/locales/en.json'
import worktreeGroupsEN from '../components/sidebar/fork-worktree-groups/locales/en.json'
import en from '../components/native-chat/fork-native-chat-width/locales/en.json'
import worktreeGroupsES from '../components/sidebar/fork-worktree-groups/locales/es.json'
import es from '../components/native-chat/fork-native-chat-width/locales/es.json'
import worktreeGroupsJA from '../components/sidebar/fork-worktree-groups/locales/ja.json'
import ja from '../components/native-chat/fork-native-chat-width/locales/ja.json'
import worktreeGroupsKO from '../components/sidebar/fork-worktree-groups/locales/ko.json'
import ko from '../components/native-chat/fork-native-chat-width/locales/ko.json'
import worktreeGroupsZH from '../components/sidebar/fork-worktree-groups/locales/zh.json'
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

const FORK_CATALOGS: Record<ForkLocale, ForkCatalog[]> = {
  en: [relayEN, en, worktreeGroupsEN],
  es: [relayES, es, worktreeGroupsES],
  ja: [relayJA, ja, worktreeGroupsJA],
  ko: [relayKO, ko, worktreeGroupsKO],
  zh: [relayZH, zh, worktreeGroupsZH]
}

export function registerForkLocalizationCatalogs(i18n: ForkCatalogRegistrar): void {
  for (const catalog of FORK_CATALOGS.en) {
    i18n.addResourceBundle('en', 'translation', catalog, true, true)
  }
  i18n.on('loaded', (resources) => {
    for (const language of Object.keys(resources)) {
      const catalog = FORK_CATALOGS[language as ForkLocale]
      if (catalog) {
        for (const resources of catalog) {
          i18n.addResourceBundle(language, 'translation', resources, true, true)
        }
      }
    }
  })
}
