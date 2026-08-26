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

import dockEN from '../components/terminal-pane/fork-terminal-dock/locales/en.json'
import dockES from '../components/terminal-pane/fork-terminal-dock/locales/es.json'
import dockJA from '../components/terminal-pane/fork-terminal-dock/locales/ja.json'
import dockKO from '../components/terminal-pane/fork-terminal-dock/locales/ko.json'
import dockZH from '../components/terminal-pane/fork-terminal-dock/locales/zh.json'
import dockSettingsEN from '../components/settings/fork-terminal-dock/locales/en.json'
import dockSettingsES from '../components/settings/fork-terminal-dock/locales/es.json'
import dockSettingsJA from '../components/settings/fork-terminal-dock/locales/ja.json'
import dockSettingsKO from '../components/settings/fork-terminal-dock/locales/ko.json'
import dockSettingsZH from '../components/settings/fork-terminal-dock/locales/zh.json'
import handoffSettingsEN from '../components/settings/fork-session-handoff/locales/en.json'
import handoffSettingsES from '../components/settings/fork-session-handoff/locales/es.json'
import handoffSettingsJA from '../components/settings/fork-session-handoff/locales/ja.json'
import handoffSettingsKO from '../components/settings/fork-session-handoff/locales/ko.json'
import handoffSettingsZH from '../components/settings/fork-session-handoff/locales/zh.json'
import agentComposerEN from '../components/native-chat/fork-agent-composer/locales/en.json'
import agentComposerES from '../components/native-chat/fork-agent-composer/locales/es.json'
import agentComposerJA from '../components/native-chat/fork-agent-composer/locales/ja.json'
import agentComposerKO from '../components/native-chat/fork-agent-composer/locales/ko.json'
import agentComposerZH from '../components/native-chat/fork-agent-composer/locales/zh.json'
import skillPluginsEN from '../components/native-chat/fork-skill-plugin-attribution/locales/en.json'
import skillPluginsES from '../components/native-chat/fork-skill-plugin-attribution/locales/es.json'
import skillPluginsJA from '../components/native-chat/fork-skill-plugin-attribution/locales/ja.json'
import skillPluginsKO from '../components/native-chat/fork-skill-plugin-attribution/locales/ko.json'
import skillPluginsZH from '../components/native-chat/fork-skill-plugin-attribution/locales/zh.json'
import handoffEN from '../components/agent-session-continuation/fork-session-handoff/locales/en.json'
import handoffES from '../components/agent-session-continuation/fork-session-handoff/locales/es.json'
import handoffJA from '../components/agent-session-continuation/fork-session-handoff/locales/ja.json'
import handoffKO from '../components/agent-session-continuation/fork-session-handoff/locales/ko.json'
import handoffZH from '../components/agent-session-continuation/fork-session-handoff/locales/zh.json'
import dirtyBranchEN from '../components/right-sidebar/fork-dirty-branch-indicator/locales/en.json'
import dirtyBranchES from '../components/right-sidebar/fork-dirty-branch-indicator/locales/es.json'
import dirtyBranchJA from '../components/right-sidebar/fork-dirty-branch-indicator/locales/ja.json'
import dirtyBranchKO from '../components/right-sidebar/fork-dirty-branch-indicator/locales/ko.json'
import dirtyBranchZH from '../components/right-sidebar/fork-dirty-branch-indicator/locales/zh.json'

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
  en: [
    relayEN,
    en,
    worktreeGroupsEN,
    dockEN,
    dockSettingsEN,
    handoffSettingsEN,
    agentComposerEN,
    skillPluginsEN,
    handoffEN,
    dirtyBranchEN
  ],
  es: [
    relayES,
    es,
    worktreeGroupsES,
    dockES,
    dockSettingsES,
    handoffSettingsES,
    agentComposerES,
    skillPluginsES,
    handoffES,
    dirtyBranchES
  ],
  ja: [
    relayJA,
    ja,
    worktreeGroupsJA,
    dockJA,
    dockSettingsJA,
    handoffSettingsJA,
    agentComposerJA,
    skillPluginsJA,
    handoffJA,
    dirtyBranchJA
  ],
  ko: [
    relayKO,
    ko,
    worktreeGroupsKO,
    dockKO,
    dockSettingsKO,
    handoffSettingsKO,
    agentComposerKO,
    skillPluginsKO,
    handoffKO,
    dirtyBranchKO
  ],
  zh: [
    relayZH,
    zh,
    worktreeGroupsZH,
    dockZH,
    dockSettingsZH,
    handoffSettingsZH,
    agentComposerZH,
    skillPluginsZH,
    handoffZH,
    dirtyBranchZH
  ]
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
