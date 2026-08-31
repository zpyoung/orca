import { posix as pathPosix } from 'node:path'
import { runWslProcess } from '../../wsl/wsl-runner'
import {
  buildWslClaudePluginMetadataCommand,
  parseWslClaudePluginMetadataOutput
} from '../claude-plugin-skill-sources-wsl'
import {
  getClaudePluginMetadataPaths,
  resolveClaudePluginSkillSources
} from '../claude-plugin-skill-sources'
import type { SkillScanRoot } from '../skill-discovery-sources'
import { applyLivePluginSkillOverrides } from './live-plugin-marketplace-override'
import {
  getKnownMarketplacesPath,
  listDirectoryMarketplaces
} from './live-plugin-marketplace-registry'

const WSL_METADATA_TIMEOUT_MS = 5_000
const WSL_METADATA_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

async function executeWslMetadataRead(distro: string, script: string): Promise<string> {
  // Why bash: the payload is the sibling metadata reader's, authored for bash.
  const result = await runWslProcess({
    distro,
    // 'none': base64/printf/stat over $HOME paths, no bare tool to find.
    loginPath: 'none',
    script,
    shell: 'bash',

    timeoutMs: WSL_METADATA_TIMEOUT_MS,
    maxOutputBytes: WSL_METADATA_MAX_OUTPUT_BYTES
  })
  // Truncated-but-well-formed output would otherwise parse as real metadata.
  if (result.code !== 0 || result.timedOut) {
    throw new Error('live-plugin-marketplace-sources-wsl-read-failed')
  }
  return result.stdout
}

async function readMetadataInDistro(
  distro: string,
  paths: readonly string[]
): Promise<(string | null)[]> {
  const output = await executeWslMetadataRead(distro, buildWslClaudePluginMetadataCommand(paths))
  return parseWslClaudePluginMetadataOutput(output, paths.length)
}

/**
 * WSL counterpart of `discoverLiveClaudePluginSkillSources`.
 *
 * `known_marketplaces.json` rides along in the metadata read that already
 * happens, so a distro with no directory marketplace still costs exactly one
 * `wsl.exe` boot; the manifest batch is a second and final one.
 */
export async function discoverLiveClaudePluginSkillSourcesInWsl(args: {
  distro: string
  homeDir: string
  cwd: string
}): Promise<SkillScanRoot[]> {
  const paths = getClaudePluginMetadataPaths(args.homeDir, args.cwd, pathPosix)
  const metadataPaths = [
    paths.installedPlugins,
    ...paths.settings,
    getKnownMarketplacesPath(args.homeDir, pathPosix)
  ]
  // Why: plugin enablement and install paths belong to the distro just like
  // SKILL.md identity; reading them through UNC could apply Windows semantics.
  const contents = await readMetadataInDistro(args.distro, metadataPaths)
  const installedPlugins = contents[0] ?? null
  const settings = contents.slice(1, 1 + paths.settings.length)
  const knownMarketplaces = contents[metadataPaths.length - 1] ?? null
  const roots = resolveClaudePluginSkillSources({
    metadata: { installedPlugins, settings },
    cwd: args.cwd,
    pathApi: pathPosix
  })
  if (roots.length === 0) {
    return roots
  }
  const marketplaces = listDirectoryMarketplaces(knownMarketplaces, pathPosix)
  if (marketplaces.length === 0) {
    return roots
  }
  try {
    const manifestContents = await readMetadataInDistro(
      args.distro,
      marketplaces.map((marketplace) => marketplace.manifestPath)
    )
    return applyLivePluginSkillOverrides({
      roots,
      installedPluginsRaw: installedPlugins,
      marketplaces,
      manifestContents,
      pathApi: pathPosix
    })
  } catch {
    return roots
  }
}
