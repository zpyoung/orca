import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { ForkHandoffTranscriptProbeFailure } from '../../shared/fork-session-handoff/session-transcript-probe-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getAiVaultWslHomeDirs } from '../ai-vault/cached-session-list'
import { remoteSessionSources } from '../ai-vault/remote-session-scanner-sources'
import type { RemoteSessionSource } from '../ai-vault/remote-session-scanner-types'
import {
  AI_VAULT_AGENT_SOURCES,
  isDiscoverableSessionFile
} from '../ai-vault/session-scanner-agent-sources'
import type { AiVaultScanOptions } from '../ai-vault/session-scanner-types'
import { getActiveSshAiVaultHostInfo } from '../ipc/ssh'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'

/**
 * The disk a transcript lives on, and the rules for deciding a path belongs to
 * the agent that wrote it.
 *
 * Local and SSH answer the same four questions with different machinery, and
 * the probe is written against this port so a remote handoff runs the same
 * candidate chain rather than degrading to a single existence check.
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
  /** Remote hosts have no session-id index, so the probe substitutes a sibling
   *  lookup in the buckets it already knows. */
  supportsSessionIdSearch: boolean
}

export type ForkTranscriptStat = { isFile: boolean; modifiedAt: number }

export type ResolveForkTranscriptHostDeps = {
  wslHomeDirs?: () => Promise<readonly string[]>
  rootOptions?: AiVaultScanOptions
  statPath?: typeof stat
  readLocalDirectory?: (dirPath: string) => Promise<string[]>
  sshHostInfo?: typeof getActiveSshAiVaultHostInfo
  sshProvider?: typeof requireSshFilesystemProvider
}

export type ForkTranscriptHostResolution =
  | { host: ForkTranscriptHost }
  | { failure: 'unsupported-agent' | 'host-unavailable' }

/** Build the host port for `agent`, on the SSH target when one owns the disk. */
export async function resolveForkTranscriptHost(
  agent: AiVaultAgent,
  connectionId: string | null,
  deps: ResolveForkTranscriptHostDeps = {}
): Promise<ForkTranscriptHostResolution> {
  return connectionId ? resolveSshHost(agent, connectionId, deps) : resolveLocalHost(agent, deps)
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
      },
      supportsSessionIdSearch: true
    }
  }
}

function resolveSshHost(
  agent: AiVaultAgent,
  connectionId: string,
  deps: ResolveForkTranscriptHostDeps
): ForkTranscriptHostResolution {
  const hostInfo = (deps.sshHostInfo ?? getActiveSshAiVaultHostInfo)(connectionId)
  if (!hostInfo) {
    return { failure: 'host-unavailable' }
  }
  const platform = hostInfo.hostPlatform
  const sources = remoteSessionSources(hostInfo.remoteHome, platform).filter(
    (source) => source.agent === agent
  )
  if (sources.length === 0) {
    return { failure: 'unsupported-agent' }
  }
  let provider: ReturnType<typeof requireSshFilesystemProvider>
  try {
    provider = (deps.sshProvider ?? requireSshFilesystemProvider)(connectionId)
  } catch {
    return { failure: 'host-unavailable' }
  }
  const roots = sources
    .map((source) => source.rootDir)
    .filter((rootDir) => rootDir.trim().length > 0)
  return {
    host: {
      roots,
      normalizePath: (value) => normalizeRemotePath(value, platform),
      joinPath: (dirPath, entryName) => joinRemotePath(platform, dirPath, entryName),
      authorize: (candidatePath) => {
        const contained = sources
          .map((source) => ({
            source,
            segments: remoteSegmentsInsideRoot(source.rootDir, candidatePath, platform)
          }))
          .filter(
            (entry): entry is { source: (typeof sources)[number]; segments: string[] } =>
              entry.segments !== null
          )
        if (contained.length === 0) {
          return 'path-outside-known-roots'
        }
        const discoverable = contained.some(({ source, segments }) =>
          isDiscoverableRemoteFile(source, segments, candidatePath)
        )
        return discoverable ? null : 'undiscoverable-path'
      },
      readDirectory: async (dirPath) =>
        (await provider.readDir(dirPath)).map((entry) => entry.name),
      statFile: async (filePath) => {
        const stats = await provider.stat(filePath)
        return { isFile: stats.type === 'file', modifiedAt: stats.mtimeMs ?? stats.mtime }
      },
      // A remote id index would need a whole-root walk over the wire; the bucket
      // scan reaches the same rotated-id file for a fraction of the round trips.
      supportsSessionIdSearch: false
    }
  }
}

/** The remote mirror of `isDiscoverableSessionFile`, over segments already
 *  proven to sit below the source's root. */
function isDiscoverableRemoteFile(
  source: RemoteSessionSource,
  segments: readonly string[],
  candidatePath: string
): boolean {
  const fileName = segments.at(-1) ?? ''
  if (!source.extensions.includes(remoteExtension(fileName))) {
    return false
  }
  if (source.filePredicate && !source.filePredicate(candidatePath)) {
    return false
  }
  // The remote scanner prunes sibling subagent transcripts from its walk rather
  // than through a directoryPredicate, so ask it the same question directly.
  const { partitionSubagentTranscripts } = source
  if (
    partitionSubagentTranscripts &&
    partitionSubagentTranscripts([candidatePath]).sessionFilePaths.length === 0
  ) {
    return false
  }
  const { directoryPredicate } = source
  return directoryPredicate
    ? segments.slice(0, -1).every((name, depth) => directoryPredicate(name, depth))
    : true
}

function remoteSeparatorPattern(platform: RemoteHostPlatform): RegExp {
  return platform.pathFlavor === 'windows' ? /[\\/]+/ : /\/+/
}

function normalizeRemotePath(value: string, platform: RemoteHostPlatform): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }
  // joinRemotePath emits '/' for both flavors, so one separator keeps every
  // path the probe compares in a single spelling.
  const segments = trimmed.split(remoteSeparatorPattern(platform))
  const leadingRoot = segments[0] === '' ? '/' : ''
  const kept = segments.filter((segment) => segment && segment !== '.')
  return `${leadingRoot}${kept.join('/')}`
}

function remoteSegments(value: string, platform: RemoteHostPlatform): string[] {
  return normalizeRemotePath(value, platform)
    .split(remoteSeparatorPattern(platform))
    .filter(Boolean)
}

/** Candidate segments below `rootDir`, or null when it escapes the root. A `..`
 *  segment fails outright: no remote resolve is available to collapse it. */
function remoteSegmentsInsideRoot(
  rootDir: string,
  candidatePath: string,
  platform: RemoteHostPlatform
): string[] | null {
  const rootSegments = remoteSegments(rootDir, platform)
  const candidateSegments = remoteSegments(candidatePath, platform)
  if (candidateSegments.includes('..') || candidateSegments.length <= rootSegments.length) {
    return null
  }
  const sameCase =
    platform.pathFlavor === 'windows'
      ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
      : (left: string, right: string) => left === right
  const contained = rootSegments.every((segment, index) =>
    sameCase(segment, candidateSegments[index] ?? '')
  )
  return contained ? candidateSegments.slice(rootSegments.length) : null
}

function remoteExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot).toLowerCase() : ''
}
