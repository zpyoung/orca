import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ExecutionHostId } from '../../shared/execution-host'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'

export type PipelineReportPathTarget = Readonly<{
  workspaceKind: 'git' | 'folder'
  gitDir?: string
  workspacePath: string
  executionHostId?: ExecutionHostId
}>

export type PipelineWorkspaceTarget = PipelineReportPathTarget &
  Readonly<{
    executionHostId: ExecutionHostId
    workspaceId?: string
  }>

export const MAX_PIPELINE_REPORT_BYTES = 256 * 1024

/** Returns the unique, workspace-authoritative report location for one dispatch attempt. */
export function issuePipelineReportPath(
  target: PipelineReportPathTarget,
  attemptFingerprint: string
): string {
  const root = target.workspaceKind === 'git' ? target.gitDir : target.workspacePath
  if (!root) {
    throw new Error('Git pipeline report target requires gitDir')
  }
  const digest = createHash('sha256').update(attemptFingerprint).digest('hex')
  const pathFlavor = target.executionHostId
    ? resolveLeasePathFlavor(target.executionHostId, root)
    : null
  const joinPath = pathFlavor?.join ?? join
  return target.workspaceKind === 'git'
    ? joinPath(root, 'orca-heimdall', 'pipeline', 'reports', `${digest}.json`)
    : joinPath(root, '.orca', 'heimdall', 'pipeline', 'reports', `${digest}.json`)
}

/** Returns the workspace root that bounds hardened report reads for this target. */
export function pipelineReportAuthorityRoot(target: PipelineReportPathTarget): string {
  if (target.workspaceKind === 'git') {
    if (!target.gitDir) {
      throw new Error('Git pipeline report target requires gitDir')
    }
    return target.gitDir
  }
  return target.workspacePath
}
