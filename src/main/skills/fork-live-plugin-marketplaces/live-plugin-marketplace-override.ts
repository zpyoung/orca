import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { SkillDiscoveryPathApi } from '../claude-plugin-skill-sources'
import { stablePathId, type SkillScanRoot } from '../skill-discovery-sources'
import type { DirectoryMarketplace } from './live-plugin-marketplace-registry'

const defaultPathApi: SkillDiscoveryPathApi = { basename, isAbsolute, join, relative, sep }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJson(rawJson: string | null): unknown {
  if (!rawJson) {
    return null
  }
  try {
    return JSON.parse(rawJson)
  } catch {
    return null
  }
}

/**
 * Index every install's `<installPath>/skills` to the plugin id that owns it.
 *
 * Why every install rather than the active one: which install upstream selected
 * is already encoded in the root's path, so matching on the path reuses that
 * choice instead of re-deriving it.
 */
export function buildPluginIdByCacheSkillsPath(
  installedPluginsRaw: string | null,
  pathApi: SkillDiscoveryPathApi = defaultPathApi
): Map<string, string> {
  const plugins = asRecord(asRecord(parseJson(installedPluginsRaw))?.plugins)
  const index = new Map<string, string>()
  if (!plugins) {
    return index
  }
  for (const [pluginId, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) {
      continue
    }
    for (const install of installs) {
      const installPath = asRecord(install)?.installPath
      if (typeof installPath !== 'string' || !pathApi.isAbsolute(installPath)) {
        continue
      }
      const skillsPath = pathApi.join(installPath, 'skills')
      if (!index.has(skillsPath)) {
        index.set(skillsPath, pluginId)
      }
    }
  }
  return index
}

function containedSubpath(
  installLocation: string,
  source: string,
  pathApi: SkillDiscoveryPathApi
): string | null {
  if (!source || pathApi.isAbsolute(source)) {
    return null
  }
  const resolved = pathApi.join(installLocation, source)
  const relativePath = pathApi.relative(installLocation, resolved)
  const escapes =
    relativePath === '..' ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  return escapes ? null : resolved
}

/**
 * Map `<plugin>@<marketplace>` to the live `skills` directory the harness loads.
 *
 * `manifestContents` is positional against `marketplaces`. The id's suffix is
 * the `known_marketplaces.json` key, never the manifest's own `name` — the two
 * can disagree and only the key is what installs are recorded under.
 */
export function resolveLivePluginSkillPaths(args: {
  marketplaces: readonly DirectoryMarketplace[]
  manifestContents: readonly (string | null)[]
  pathApi?: SkillDiscoveryPathApi
}): Map<string, string> {
  const pathApi = args.pathApi ?? defaultPathApi
  const livePaths = new Map<string, string>()
  args.marketplaces.forEach((marketplace, index) => {
    const plugins = asRecord(parseJson(args.manifestContents[index] ?? null))?.plugins
    if (!Array.isArray(plugins)) {
      return
    }
    for (const entry of plugins) {
      const plugin = asRecord(entry)
      const name = plugin?.name
      const source = plugin?.source
      if (typeof name !== 'string' || !name || typeof source !== 'string') {
        continue
      }
      const pluginDir = containedSubpath(marketplace.installLocation, source, pathApi)
      if (!pluginDir) {
        continue
      }
      const pluginId = `${name}@${marketplace.name}`
      if (!livePaths.has(pluginId)) {
        livePaths.set(pluginId, pathApi.join(pluginDir, 'skills'))
      }
    }
  })
  return livePaths
}

/**
 * Repoint plugin roots whose cache copy has a live source at the live directory.
 *
 * The live root *replaces* the cached one so a skill present in both cannot list
 * twice. Roots with no live counterpart are returned untouched.
 */
export function rewriteRootsWithLivePluginPaths(args: {
  roots: readonly SkillScanRoot[]
  pluginIdByCacheSkillsPath: ReadonlyMap<string, string>
  livePluginSkillPaths: ReadonlyMap<string, string>
}): SkillScanRoot[] {
  const rewritten: SkillScanRoot[] = []
  const seenPaths = new Set<string>()
  for (const root of args.roots) {
    const pluginId =
      root.sourceKind === 'plugin' ? args.pluginIdByCacheSkillsPath.get(root.path) : undefined
    const livePath = pluginId ? args.livePluginSkillPaths.get(pluginId) : undefined
    const resolved =
      livePath && livePath !== root.path
        ? { ...root, id: `claude-plugin-${stablePathId(livePath)}`, path: livePath }
        : root
    if (seenPaths.has(resolved.path)) {
      continue
    }
    seenPaths.add(resolved.path)
    rewritten.push(resolved)
  }
  return rewritten
}

export function applyLivePluginSkillOverrides(args: {
  roots: readonly SkillScanRoot[]
  installedPluginsRaw: string | null
  marketplaces: readonly DirectoryMarketplace[]
  manifestContents: readonly (string | null)[]
  pathApi?: SkillDiscoveryPathApi
}): SkillScanRoot[] {
  const pathApi = args.pathApi ?? defaultPathApi
  return rewriteRootsWithLivePluginPaths({
    roots: args.roots,
    pluginIdByCacheSkillsPath: buildPluginIdByCacheSkillsPath(args.installedPluginsRaw, pathApi),
    livePluginSkillPaths: resolveLivePluginSkillPaths({
      marketplaces: args.marketplaces,
      manifestContents: args.manifestContents,
      pathApi
    })
  })
}
