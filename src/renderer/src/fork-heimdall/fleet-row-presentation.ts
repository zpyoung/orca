import { getExecutionHostLabel } from '../../../shared/execution-host'
import type {
  WatcherFleetActivity,
  WatcherFleetEntry
} from '../../../shared/fork-heimdall/fleet-types'

export type ResolvedFleetActivity =
  | { kind: 'unverifiable'; lastConfirmedAtMs: number }
  | { kind: 'unknown' }
  | WatcherFleetActivity

export type ResolvedFleetWorkspace = {
  label: string
  kind: 'git' | 'folder'
  branch: string | null
  hostLabel: string | null
  fullPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Contact authority wins over cached owner activity so a lost host never looks idle or active. */
export function resolveFleetActivity(row: WatcherFleetEntry): ResolvedFleetActivity {
  if (row.contact === 'unverifiable' || row.entry.status.state === 'unreachable') {
    return { kind: 'unverifiable', lastConfirmedAtMs: row.observedAtMs }
  }
  return row.activity ?? { kind: 'unknown' }
}

/** Objective phases only come from owner snapshot projection; runner phases are not substitutes. */
export function resolveFleetWorkflowPhase(row: WatcherFleetEntry): string | null {
  if (row.workflowPhase !== undefined) {
    return row.workflowPhase
  }
  return row.entry.enrollment.kind === 'objective' ? null : row.entry.status.phase
}

export function resolveFleetWorkspace(row: WatcherFleetEntry): ResolvedFleetWorkspace {
  const enrollment = row.entry.enrollment
  const payload = isRecord(enrollment.kindPayload) ? enrollment.kindPayload : null
  const objectiveWorkspaceKind =
    enrollment.kind === 'objective' &&
    (payload?.workspaceKind === 'git' || payload?.workspaceKind === 'folder')
      ? payload.workspaceKind
      : null
  const fallbackKind =
    enrollment.kind === 'hosted-review'
      ? 'git'
      : (objectiveWorkspaceKind ?? (enrollment.worktreeId === null ? 'folder' : 'git'))
  const withoutTrailingSeparators = enrollment.workspacePath.replace(/[\\/]+$/, '')
  const fallbackLabel = withoutTrailingSeparators.split(/[\\/]/).at(-1) || enrollment.workspacePath
  return {
    label: row.workspace?.label ?? fallbackLabel,
    kind: row.workspace?.kind ?? fallbackKind,
    branch: row.workspace?.branch ?? null,
    hostLabel:
      enrollment.executionHostId === 'local'
        ? null
        : getExecutionHostLabel(enrollment.executionHostId),
    fullPath: enrollment.workspacePath
  }
}
