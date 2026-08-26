import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { SkillDiscoveryPathApi } from '../claude-plugin-skill-sources'

/** A marketplace Claude loads plugins from in place rather than from its cache copy. */
export type DirectoryMarketplace = {
  /** The `known_marketplaces.json` key — the suffix of every `<plugin>@<marketplace>` id. */
  name: string
  installLocation: string
  manifestPath: string
}

const defaultPathApi: SkillDiscoveryPathApi = { basename, isAbsolute, join, relative, sep }

export function getKnownMarketplacesPath(
  homeDir: string,
  pathApi: SkillDiscoveryPathApi = defaultPathApi
): string {
  return pathApi.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The directory-sourced marketplaces declared in `known_marketplaces.json`.
 *
 * Returns `[]` for absent or malformed input so callers keep the cached roots.
 * `github`/`git` marketplaces are excluded: those really are copied into the
 * cache, so their cached root already matches what the harness loads.
 */
export function listDirectoryMarketplaces(
  rawJson: string | null,
  pathApi: SkillDiscoveryPathApi = defaultPathApi
): DirectoryMarketplace[] {
  if (!rawJson) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return []
  }
  const marketplaces = asRecord(parsed)
  if (!marketplaces) {
    return []
  }
  const resolved: DirectoryMarketplace[] = []
  for (const [name, value] of Object.entries(marketplaces)) {
    const entry = asRecord(value)
    const source = asRecord(entry?.source)
    const installLocation = entry?.installLocation
    if (
      !name ||
      source?.source !== 'directory' ||
      typeof installLocation !== 'string' ||
      !pathApi.isAbsolute(installLocation)
    ) {
      continue
    }
    resolved.push({
      name,
      installLocation,
      manifestPath: pathApi.join(installLocation, '.claude-plugin', 'marketplace.json')
    })
  }
  return resolved
}
