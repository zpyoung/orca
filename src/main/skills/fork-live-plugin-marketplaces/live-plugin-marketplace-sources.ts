import { open, stat } from 'node:fs/promises'
import {
  discoverClaudePluginSkillSources,
  getClaudePluginMetadataPaths
} from '../claude-plugin-skill-sources'
import type { SkillScanRoot } from '../skill-discovery-sources'
import { applyLivePluginSkillOverrides } from './live-plugin-marketplace-override'
import {
  getKnownMarketplacesPath,
  listDirectoryMarketplaces
} from './live-plugin-marketplace-registry'

const MAX_MARKETPLACE_METADATA_BYTES = 4 * 1024 * 1024

async function readMarketplaceFile(pathValue: string): Promise<string | null> {
  try {
    const fileStat = await stat(pathValue)
    if (!fileStat.isFile() || fileStat.size > MAX_MARKETPLACE_METADATA_BYTES) {
      return null
    }
    const file = await open(pathValue, 'r')
    try {
      const buffer = Buffer.alloc(fileStat.size)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/**
 * Claude plugin skill roots, with directory-sourced marketplaces repointed at
 * the live plugin directory the harness actually loads.
 *
 * A cached copy of a directory marketplace is frozen at its last `plugin
 * update`, so the picker would otherwise offer a stale skill set. Any read or
 * parse failure degrades to the cached roots rather than dropping a plugin.
 */
export async function discoverLiveClaudePluginSkillSources(args: {
  homeDir: string
  cwd: string
}): Promise<SkillScanRoot[]> {
  const roots = await discoverClaudePluginSkillSources(args)
  if (roots.length === 0) {
    return roots
  }
  try {
    const marketplaces = listDirectoryMarketplaces(
      await readMarketplaceFile(getKnownMarketplacesPath(args.homeDir))
    )
    if (marketplaces.length === 0) {
      return roots
    }
    const [installedPluginsRaw, ...manifestContents] = await Promise.all([
      readMarketplaceFile(getClaudePluginMetadataPaths(args.homeDir, args.cwd).installedPlugins),
      ...marketplaces.map((marketplace) => readMarketplaceFile(marketplace.manifestPath))
    ])
    return applyLivePluginSkillOverrides({
      roots,
      installedPluginsRaw,
      marketplaces,
      manifestContents
    })
  } catch {
    return roots
  }
}
