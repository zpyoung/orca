import { execFile } from 'node:child_process'
import { posix as pathPosix } from 'node:path'
import { buildWslExecArgs } from '../../../shared/wsl-login-shell-command'
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
const WSL_METADATA_MAX_BUFFER_BYTES = 32 * 1024 * 1024

function executeWslMetadataRead(distro: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      buildWslExecArgs(distro, ['bash', '-c', command]),
      {
        encoding: 'utf8',
        maxBuffer: WSL_METADATA_MAX_BUFFER_BYTES,
        timeout: WSL_METADATA_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
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
