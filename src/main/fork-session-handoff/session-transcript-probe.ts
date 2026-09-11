import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type {
  ForkHandoffTranscriptProbeFailure,
  ForkHandoffTranscriptProbeRequest,
  ForkHandoffTranscriptProbeResult,
  ForkHandoffTranscriptProvenance
} from '../../shared/fork-session-handoff/session-transcript-probe-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import type { AgentType } from '../../shared/native-chat-types'
import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'
import { AI_VAULT_AGENT_SOURCES } from '../ai-vault/session-scanner-agent-sources'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  getForkPaneTranscriptPaths,
  isForkSessionClaimedByOtherPane
} from './pane-transcript-history'
import { scanForkClaudeProjectTranscript } from './session-transcript-directory-scan'
import {
  resolveForkTranscriptHost,
  type ForkTranscriptHost,
  type ResolveForkTranscriptHostDeps
} from './session-transcript-host'

export type ResolveHandoffTranscriptDeps = ResolveForkTranscriptHostDeps & {
  resolveHost?: typeof resolveForkTranscriptHost
  resolveSessionFile?: typeof resolveSessionFilePath
  paneTranscriptPaths?: typeof getForkPaneTranscriptPaths
  isSessionClaimedByOtherPane?: typeof isForkSessionClaimedByOtherPane
  scanProjectTranscript?: typeof scanForkClaudeProjectTranscript
}

type Candidate = { path: string; provenance: ForkHandoffTranscriptProvenance }

type CandidateSet = {
  candidates: Candidate[]
  /** Raised by a stage that found something it refuses to hand back, so a
   *  chain that otherwise runs dry reports "could not decide", not "absent". */
  refusal: ForkHandoffTranscriptProbeFailure | null
}

/**
 * Locate the transcript a handoff would reference, on the host that owns the
 * transcript disk.
 *
 * Authorization is the agent's own session roots, not the workspace allow-list
 * the generic `fs:pathExists` enforces: a transcript legitimately lives outside
 * every repo, so routing this question through that door denied every local
 * handoff and read back as "no transcript exists". The accept rule is the AI
 * Vault scanner's, so a path it would never surface as a session cannot be
 * probed here either.
 *
 * Candidates are tried in descending order of authority — the agent's reported
 * path, the id-based lookup, the pane's earlier reports, then a project-bucket
 * scan — because Claude Code reports a rotated session id before writing a file
 * for it, leaving the live conversation under the previous id. The same chain
 * runs against an SSH target, where the host port swaps the filesystem and the
 * path flavor rather than the resolution strategy.
 */
export async function resolveHandoffTranscript(
  request: ForkHandoffTranscriptProbeRequest,
  deps: ResolveHandoffTranscriptDeps = {}
): Promise<ForkHandoffTranscriptProbeResult> {
  const vaultAgent = resolveVaultAgent(request.agent)
  if (!vaultAgent) {
    return { outcome: 'unverifiable', reason: 'unsupported-agent' }
  }
  const resolution = await (deps.resolveHost ?? resolveForkTranscriptHost)(
    vaultAgent,
    request.connectionId,
    deps
  )
  if ('failure' in resolution) {
    return { outcome: 'unverifiable', reason: resolution.failure }
  }
  const { host } = resolution

  let collected: CandidateSet
  try {
    collected = await collectCandidates(request, host, deps)
  } catch {
    return { outcome: 'unverifiable', reason: 'resolve-failed' }
  }

  // Why the first refusal and not the last: candidates run best-authority first,
  // so the earliest "could not decide" is the one worth reporting.
  let refusal: ForkHandoffTranscriptProbeFailure | null = null
  for (const candidate of collected.candidates) {
    const verdict = await inspectCandidate(candidate, host)
    if (verdict.outcome === 'found') {
      return verdict
    }
    if (verdict.outcome === 'unverifiable') {
      refusal ??= verdict.reason
    }
  }
  const settled = refusal ?? collected.refusal
  return settled ? { outcome: 'unverifiable', reason: settled } : { outcome: 'missing' }
}

async function inspectCandidate(
  candidate: Candidate,
  host: ForkTranscriptHost
): Promise<ForkHandoffTranscriptProbeResult> {
  // Normalize first: containment compares textually and would otherwise pass
  // `<root>/../../etc/secrets.jsonl`.
  const resolvedPath = host.normalizePath(candidate.path)
  const refusal = host.authorize(resolvedPath)
  if (refusal) {
    return { outcome: 'unverifiable', reason: refusal }
  }
  try {
    const stats = await host.statFile(resolvedPath)
    return stats.isFile
      ? { outcome: 'found', transcriptPath: resolvedPath, provenance: candidate.provenance }
      : { outcome: 'missing' }
  } catch (error) {
    return isENOENT(error)
      ? { outcome: 'missing' }
      : { outcome: 'unverifiable', reason: 'stat-failed' }
  }
}

async function collectCandidates(
  request: ForkHandoffTranscriptProbeRequest,
  host: ForkTranscriptHost,
  deps: ResolveHandoffTranscriptDeps
): Promise<CandidateSet> {
  const candidates: Candidate[] = []
  const seen = new Set<string>()
  const add = (path: string | null | undefined, provenance: ForkHandoffTranscriptProvenance) => {
    const trimmed = path?.trim()
    if (!trimmed || seen.has(trimmed)) {
      return
    }
    seen.add(trimmed)
    candidates.push({ path: trimmed, provenance })
  }

  add(request.transcriptPath, 'reported')
  for (const path of await resolveBySessionId(request, host, deps)) {
    add(path, 'session-id')
  }
  for (const path of (deps.paneTranscriptPaths ?? getForkPaneTranscriptPaths)(request.paneKey)) {
    add(path, 'pane-history')
  }
  const scan = await scanProjectBucket(request, host, deps)
  add(scan.path, 'project-scan')
  return { candidates, refusal: scan.ambiguous ? 'ambiguous-project-scan' : null }
}

/** Recovers a session whose hook-reported path has gone stale. A host with a
 *  session-id index answers directly; a remote one is asked for the same id
 *  beside the paths it already knows, which is where a rotation lands. */
async function resolveBySessionId(
  request: ForkHandoffTranscriptProbeRequest,
  host: ForkTranscriptHost,
  deps: ResolveHandoffTranscriptDeps
): Promise<string[]> {
  const transcriptAgent = resolveNativeChatTranscriptAgent(request.agent)
  if (!transcriptAgent || !request.sessionId) {
    return []
  }
  if (!host.supportsSessionIdSearch) {
    return siblingSessionIdPaths(request, host, deps)
  }
  const resolved = await (deps.resolveSessionFile ?? resolveSessionFilePath)(
    request.agent as AgentType,
    request.sessionId,
    request.transcriptPath ? { transcriptPath: request.transcriptPath } : {}
  )
  return resolved ? [resolved] : []
}

/** `<id>.jsonl` in every directory this request already points at: the reported
 *  path's own directory, and the workspace's project buckets. */
function siblingSessionIdPaths(
  request: ForkHandoffTranscriptProbeRequest,
  host: ForkTranscriptHost,
  deps: ResolveHandoffTranscriptDeps
): string[] {
  const fileName = `${request.sessionId}.jsonl`
  const directories = [
    ...parentDirectories(request, host, deps),
    ...projectBucketDirs(request.workspacePath, host)
  ]
  return directories.map((dirPath) => host.joinPath(dirPath, fileName))
}

function parentDirectories(
  request: ForkHandoffTranscriptProbeRequest,
  host: ForkTranscriptHost,
  deps: ResolveHandoffTranscriptDeps
): string[] {
  const paneTranscriptPaths = deps.paneTranscriptPaths ?? getForkPaneTranscriptPaths
  const known = [request.transcriptPath, ...paneTranscriptPaths(request.paneKey)]
  return known.flatMap((filePath) => {
    const normalized = filePath ? host.normalizePath(filePath) : ''
    const cut = normalized.lastIndexOf('/')
    return cut > 0 ? [normalized.slice(0, cut)] : []
  })
}

/** Claude alone, because the bucket name is Claude's own cwd encoding. */
async function scanProjectBucket(
  request: ForkHandoffTranscriptProbeRequest,
  host: ForkTranscriptHost,
  deps: ResolveHandoffTranscriptDeps
): Promise<{ path: string | null; ambiguous: boolean }> {
  if (!request.workspacePath || resolveNativeChatTranscriptAgent(request.agent) !== 'claude') {
    return { path: null, ambiguous: false }
  }
  const isClaimed = deps.isSessionClaimedByOtherPane ?? isForkSessionClaimedByOtherPane
  return (deps.scanProjectTranscript ?? scanForkClaudeProjectTranscript)({
    workspacePath: request.workspacePath,
    rootDirs: host.roots,
    isClaimedByOtherPane: (sessionId) => isClaimed(request.paneKey, sessionId),
    joinPath: host.joinPath,
    readDirectory: host.readDirectory,
    statFile: host.statFile
  })
}

function projectBucketDirs(workspacePath: string | null, host: ForkTranscriptHost): string[] {
  if (!workspacePath) {
    return []
  }
  return encodeClaudeProjectPaths(workspacePath).flatMap((bucketName) =>
    host.roots.map((rootDir) => host.joinPath(rootDir, bucketName))
  )
}

function resolveVaultAgent(agent: string | null): AiVaultAgent | null {
  if (agent && agent in AI_VAULT_AGENT_SOURCES) {
    return agent as AiVaultAgent
  }
  // OpenClaude writes Claude's transcript layout under a distinct agent identity.
  return resolveNativeChatTranscriptAgent(agent) ?? null
}
