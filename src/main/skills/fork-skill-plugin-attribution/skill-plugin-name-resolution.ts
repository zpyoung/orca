import type { SkillScanRoot } from '../skill-discovery-sources'
import { stripUnsafeDisplayCharacters } from '../../../shared/skill-display-text'

type SkillRelativePathApi = { relative: (from: string, to: string) => string; sep: string }

const MAX_PLUGIN_NAME_LENGTH = 80

/** Sanitize an untrusted plugin name for display; null when nothing survives. */
export function safePluginName(value: string): string | null {
  return stripUnsafeDisplayCharacters(value).slice(0, MAX_PLUGIN_NAME_LENGTH) || null
}

export const CODEX_PLUGIN_CACHE_ROOT_ID = 'codex-plugin-cache'
// Codex caches every marketplace under one root as
// `<marketplace>/<plugin>/<version>/skills/...`, so unlike a Claude plugin root
// the owning plugin is only knowable from the skill's own path.
const CODEX_PLUGIN_CACHE_NAME_SEGMENT = 1

/** The plugin a scanned skill belongs to, or null outside plugin scopes. */
export function pluginNameForSkill(
  root: SkillScanRoot,
  skillFilePath: string,
  pathApi: SkillRelativePathApi
): string | null {
  if (root.sourceKind !== 'plugin') {
    return null
  }
  if (root.pluginName) {
    return root.pluginName
  }
  if (root.id !== CODEX_PLUGIN_CACHE_ROOT_ID) {
    return null
  }
  const segments = pathApi.relative(root.path, skillFilePath).split(pathApi.sep)
  // The segment has to be a directory on the way to the file, or a shallower
  // tree than the documented layout would report a file name as the plugin.
  if (segments.length <= CODEX_PLUGIN_CACHE_NAME_SEGMENT + 1) {
    return null
  }
  return safePluginName(segments[CODEX_PLUGIN_CACHE_NAME_SEGMENT])
}
