import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { ForkHandoffTranscriptProbeFailure } from '../../shared/fork-session-handoff/session-transcript-probe-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import {
  AI_VAULT_AGENT_SOURCES,
  isDiscoverableSessionFile
} from '../ai-vault/session-scanner-agent-sources'
import type { AiVaultScanOptions } from '../ai-vault/session-scanner-types'

/**
 * The disk a transcript lives on, and the rules for deciding a path belongs to
 * the agent that wrote it.
 */
export type ForkTranscriptHost = {
  roots: string[]
  /** Canonical form the probe compares and returns; collapses `..` where it can. */
  normalizePath: (value: string) => string
  joinPath: (dirPath: string, entryName: string) => string
  /** Null when the path is probeable. Applies containment first, then the
   *  agent's own accept rule, so a path the vault scanner would never surface
   *  cannot be probed here either. */
  authorize: (candidatePath: string) => ForkHandoffTranscriptProbeFailure | null
  readDirectory: (dirPath: string) => Promise<string[]>
  statFile: (filePath: string) => Promise<ForkTranscriptStat>
}

export type ForkTranscriptStat = { isFile: boolean; modifiedAt: number }

export type ResolveForkTranscriptHostDeps = {
  wslHomeDirs?: () => Promise<readonly string[]>
  rootOptions?: AiVaultScanOptions
  statPath?: typeof stat
  readLocalDirectory?: (dirPath: string) => Promise<string[]>
}

export type ForkTranscriptHostResolution =
  | { host: ForkTranscriptHost }
  | { failure: 'unsupported-agent' | 'host-unavailable' }

/** Build the host port for `agent`; a session on an SSH target has no readable disk here. */
export async function resolveForkTranscriptHost(
  agent: AiVaultAgent,
  connectionId: string | null,
  deps: ResolveForkTranscriptHostDeps = {}
): Promise<ForkTranscriptHostResolution> {
  return connectionId ? { failure: 'host-unavailable' } : resolveLocalHost(agent, deps)
}

async function resolveLocalHost(
  agent: AiVaultAgent,
  deps: ResolveForkTranscriptHostDeps
): Promise<ForkTranscriptHostResolution> {
  const source = AI_VAULT_AGENT_SOURCES[agent]
  if (!source) {
    return { failure: 'unsupported-agent' }
  }
  const wslHomeDirs = await (deps.wslHomeDirs ?? getAiVaultWslHomeDirs)()
  const roots = source
    .rootDirs(deps.rootOptions ?? {}, wslHomeDirs)
    .filter((rootDir) => rootDir.trim().length > 0)
    .map((rootDir) => resolve(rootDir))
  const statPath = deps.statPath ?? stat
  const readLocalDirectory = deps.readLocalDirectory ?? ((dirPath: string) => readdir(dirPath))
  return {
    host: {
      roots,
      normalizePath: resolve,
      joinPath: (dirPath, entryName) => resolve(dirPath, entryName),
      authorize: (candidatePath) => {
        const matchedRoot = roots.find((root) => isPathInsideOrEqual(root, candidatePath))
        if (!matchedRoot) {
          return 'path-outside-known-roots'
        }
        return isDiscoverableSessionFile(source, matchedRoot, candidatePath)
          ? null
          : 'undiscoverable-path'
      },
      readDirectory: readLocalDirectory,
      statFile: async (filePath) => {
        const stats = await statPath(filePath)
        return { isFile: stats.isFile(), modifiedAt: stats.mtimeMs }
      }
    }
  }
}
