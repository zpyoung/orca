import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import type { GitStatusEntry, GitStatusResult } from '../../../../shared/git-status-types'
import { getRuntimeGitDiff, getRuntimeGitStatus } from '@/runtime/runtime-git-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'
import { FORK_HANDOFF_DIFF_CHAR_CAP, type HandoffRepoStateBlock } from './handoff-brief-composer'
import type { HandoffTargetResolution } from './handoff-target-resolution'

export { FORK_HANDOFF_DIFF_CHAR_CAP } from './handoff-brief-composer'

type HandoffRepoStateArgs = {
  state: WorktreeRuntimeOwnerState
  target: HandoffTargetResolution
  includeDiffBodies: boolean
  signal?: AbortSignal
  diffCharCap?: number
}

/** Fetches the source workspace's git summary through the resolved execution host. */
export async function fetchHandoffRepoState(
  args: HandoffRepoStateArgs
): Promise<HandoffRepoStateBlock | null> {
  if (args.target.isFolderWorkspace) {
    return null
  }

  const context = buildRuntimeGitContext(args)
  const status = await getRuntimeGitStatus(context, { signal: args.signal })
  args.signal?.throwIfAborted()
  const diffResult = args.includeDiffBodies
    ? await fetchDiffBodies({
        context,
        entries: status.entries,
        signal: args.signal,
        charCap: normalizeCharCap(args.diffCharCap),
        statusWasTruncated: Boolean(status.didHitLimit)
      })
    : { bodies: null, truncated: false }

  return {
    branch: status.branch?.trim() || null,
    statusSummary: formatHandoffStatusSummary(status),
    changedPaths: uniqueChangedPaths(status.entries),
    diffBodies: diffResult.bodies,
    diffTruncated: diffResult.truncated
  }
}

/** Formats status entries without assuming platform-specific Git porcelain output. */
export function formatHandoffStatusSummary(status: GitStatusResult): string {
  if (status.entries.length === 0) {
    return 'Clean working tree.'
  }
  const lines = status.entries.map((entry) => {
    const path = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path
    return `${entry.area}: ${entry.status} ${path}`
  })
  const omitted = Math.max(
    0,
    (status.statusLength ?? status.entries.length) - status.entries.length
  )
  if (status.didHitLimit && omitted > 0) {
    lines.push(`... ${omitted} additional changes omitted.`)
  }
  return lines.join('\n')
}

function buildRuntimeGitContext(args: HandoffRepoStateArgs): RuntimeGitContext {
  return {
    settings: getSettingsForWorktreeRuntimeOwner(args.state, args.target.worktreeId),
    worktreeId: args.target.worktreeId,
    worktreePath: args.target.workspacePath,
    ...(args.target.sshConnectionId ? { connectionId: args.target.sshConnectionId } : {})
  }
}

async function fetchDiffBodies(args: {
  context: RuntimeGitContext
  entries: GitStatusEntry[]
  signal?: AbortSignal
  charCap: number
  statusWasTruncated: boolean
}): Promise<{ bodies: string | null; truncated: boolean }> {
  let bodies = ''
  let truncated = args.statusWasTruncated

  for (const entry of args.entries) {
    args.signal?.throwIfAborted()
    if (bodies.length >= args.charCap) {
      truncated = true
      break
    }
    const result = await getRuntimeGitDiff(args.context, {
      filePath: entry.path,
      staged: entry.area === 'staged'
    })
    args.signal?.throwIfAborted()
    const section = formatDiffSection(entry, result)
    const separator = bodies ? '\n\n' : ''
    const available = args.charCap - bodies.length
    const addition = `${separator}${section}`
    if (addition.length > available) {
      bodies += addition.slice(0, available)
      truncated = true
      break
    }
    bodies += addition
  }

  return { bodies: bodies || null, truncated }
}

function formatDiffSection(
  entry: GitStatusEntry,
  result: Awaited<ReturnType<typeof getRuntimeGitDiff>>
): string {
  const path = entry.oldPath ? `${entry.oldPath} -> ${entry.path}` : entry.path
  const heading = `### ${entry.area}: ${entry.status} ${path}`
  if (result.kind === 'binary') {
    return `${heading}
[binary diff omitted]`
  }
  return [heading, '--- before', result.originalContent, '+++ after', result.modifiedContent].join(
    '\n'
  )
}

function uniqueChangedPaths(entries: GitStatusEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.path))]
}

function normalizeCharCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return FORK_HANDOFF_DIFF_CHAR_CAP
  }
  return Math.max(0, Math.floor(value))
}
