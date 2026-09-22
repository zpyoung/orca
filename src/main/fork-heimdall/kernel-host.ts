import * as electron from 'electron'
import type { WorkspaceKey, WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  requireRuntimeFileProvider,
  type ResolvedRuntimeFileTarget
} from '../runtime/runtime-file-command-target'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { LeaseConfigurationError, type LeaseWorkspaceTarget } from './lease-store'

type RuntimeGitTargetResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
}

type RuntimeFileTargetResolver = {
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

type PowerMonitorLike = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  off?(event: 'suspend' | 'resume', listener: () => void): unknown
  removeListener?(event: 'suspend' | 'resume', listener: () => void): unknown
}

/** Keeps Electron power and execution-host routing outside the pure kernel loop. */
export class HeimdallKernelHost {
  private powerMonitor: PowerMonitorLike | null = null

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly findEnrollment: (key: WorkspaceKey) => WatcherEnrollment | null,
    private readonly onSuspend: () => void,
    private readonly onResume: () => void
  ) {}

  async resolveLeaseTarget(key: WorkspaceKey): Promise<LeaseWorkspaceTarget> {
    const enrollment = this.findEnrollment(key)
    if (!enrollment) {
      throw new LeaseConfigurationError(`Lease workspace is no longer enrolled: ${key}`)
    }
    const folderWorktreeId =
      enrollment.worktreeId && parseWorkspaceKey(enrollment.worktreeId)?.type === 'folder'
        ? enrollment.worktreeId
        : null
    if (enrollment.worktreeId === null || folderWorktreeId) {
      return this.resolveFolderTarget(enrollment)
    }

    const runtime: unknown = this.runtime
    if (
      typeof runtime !== 'object' ||
      runtime === null ||
      !('resolveRuntimeGitTarget' in runtime) ||
      typeof runtime.resolveRuntimeGitTarget !== 'function'
    ) {
      throw new LeaseConfigurationError('Runtime cannot resolve a Heimdall Git target')
    }
    const gitTarget = await (runtime as RuntimeGitTargetResolver).resolveRuntimeGitTarget(
      enrollment.worktreeId
    )
    if (
      gitTarget.worktree.id !== enrollment.worktreeId ||
      gitTarget.worktree.path !== enrollment.workspacePath ||
      gitTarget.executionHostId !== enrollment.executionHostId
    ) {
      throw new LeaseConfigurationError('Resolved Git authority changed after Heimdall enrollment')
    }
    return {
      kind: 'git',
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath,
      watcherId: enrollment.watcherId,
      fileProvider: requireRuntimeFileProvider(gitTarget),
      gitTarget
    }
  }

  attachPowerMonitor(): void {
    if (!('powerMonitor' in electron)) {
      return
    }
    const monitor: unknown = electron.powerMonitor
    if (
      typeof monitor !== 'object' ||
      monitor === null ||
      !('on' in monitor) ||
      typeof monitor.on !== 'function'
    ) {
      return
    }
    this.powerMonitor = monitor as PowerMonitorLike
    this.powerMonitor.on('suspend', this.onSuspend)
    this.powerMonitor.on('resume', this.onResume)
  }

  detachPowerMonitor(): void {
    const monitor = this.powerMonitor
    if (!monitor) {
      return
    }
    if (typeof monitor.off === 'function') {
      monitor.off('suspend', this.onSuspend)
      monitor.off('resume', this.onResume)
    } else if (typeof monitor.removeListener === 'function') {
      monitor.removeListener('suspend', this.onSuspend)
      monitor.removeListener('resume', this.onResume)
    }
    this.powerMonitor = null
  }

  private async resolveFolderTarget(enrollment: WatcherEnrollment): Promise<LeaseWorkspaceTarget> {
    const runtime: unknown = this.runtime
    if (
      typeof runtime !== 'object' ||
      runtime === null ||
      !('resolveRuntimeFileTarget' in runtime) ||
      typeof runtime.resolveRuntimeFileTarget !== 'function'
    ) {
      throw new LeaseConfigurationError('Runtime cannot resolve a Heimdall folder target')
    }
    const worktreeId = enrollment.worktreeId ?? `${enrollment.repoId}::${enrollment.workspacePath}`
    const fileTarget = await (runtime as RuntimeFileTargetResolver).resolveRuntimeFileTarget(
      `id:${worktreeId}`
    )
    if (
      fileTarget.worktree.id !== worktreeId ||
      fileTarget.worktree.repoId !== enrollment.repoId ||
      fileTarget.executionHostId !== enrollment.executionHostId ||
      fileTarget.worktree.path !== enrollment.workspacePath
    ) {
      throw new LeaseConfigurationError(
        'Resolved folder authority changed after Heimdall enrollment'
      )
    }
    const fileProvider = requireRuntimeFileProvider(fileTarget)
    return {
      kind: 'folder',
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath,
      watcherId: enrollment.watcherId,
      fileProvider
    }
  }
}
