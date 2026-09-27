import { basename, dirname } from 'node:path'
import { readdir } from 'node:fs/promises'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { RuntimeCommandSurfaceHost } from './orca-runtime-core'
import type { Worktree } from '../../shared/worktree/types'
import {
  LedgerError,
  type LedgerLocation,
  type LedgerRequest,
  type LedgerResponse
} from '../../shared/ledger'
import { normalizeLedgerLocation } from '../../shared/ledger-locations'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { parseWslUncPath, toWindowsWslPath } from '../../shared/wsl-paths'
import { LedgerRuntimeService, ledgerDirectoryForStore } from '../ledger/ledger-service'
import type { LedgerHostIo, LedgerHostWorkspace } from '../ledger/ledger-host-context'
import { gitExecFileAsync } from '../git/runner'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { isWindowsRemoteHost } from '../ssh/ssh-remote-platform'
import type {
  ExpectedLedgerRevision,
  LedgerCatalogRemovalResult,
  LedgerCatalogRemovalTarget
} from './runtime-ledger-catalog-removal'

/** Owns the profile-scoped ledger store and keeps its catalog in step with the repo graph. */
export class OrcaRuntimeWithLedger extends OrcaRuntimeWithResolveWaiter {
  private readonly ledgerService: LedgerRuntimeService | null
  private ledgerCatalogReconcileQueue: Promise<void> = Promise.resolve()

  constructor(...args: ConstructorParameters<typeof OrcaRuntimeWithResolveWaiter>) {
    super(...args)
    const store = args[0]
    const dataFile = store?.getDataFile?.()
    this.ledgerService = dataFile
      ? new LedgerRuntimeService({
          directory: ledgerDirectoryForStore(dataFile, basename(dirname(dataFile))),
          runtime: { runtimeId: this.runtimeId, profileId: basename(dirname(dataFile)) },
          catalog: async () => {
            const runtime = this as RuntimeCommandSurfaceHost<this>
            return {
              projects: runtime.listProjects(),
              groups: runtime.listProjectGroups(),
              folders: runtime.listFolderWorkspaces(),
              worktrees: await this.listLedgerWorktrees(),
              repos: this.listRepos()
            }
          },
          resolveHost: (workspaceId) => this.resolveLedgerHost(workspaceId),
          normalizeUiLocation: (location) => this.normalizeLedgerLocationForUi(location),
          verify: (evidence) => {
            const authority = this.verifyOrchestrationCompatibilityCaller(evidence)
            if (!authority) {
              return null
            }
            const terminal = this.getOrchestrationDispatchAuthority(authority.terminalHandle)
            if (!terminal || terminal.processIncarnation !== authority.processIncarnation) {
              return null
            }
            const pty = this.ptysById.get(terminal.ptyId)
            if (!pty || !isTuiAgent(pty.launchAgent)) {
              return null
            }
            return { kind: 'agent', tool: pty.launchAgent, model: null, providerSessionId: null }
          }
        })
      : null
    queueMicrotask(() => {
      this.ledgerService?.reconcileCatalog().catch((error) => {
        console.error('[ledger] initial catalog reconciliation failed', error)
      })
    })
  }

  protected notifyWorktreesChanged(repoId: string): void {
    this.queueLedgerCatalogReconciliation()
    super.notifyWorktreesChanged(repoId)
  }

  protected notifyReposChanged(): void {
    this.queueLedgerCatalogReconciliation()
    super.notifyReposChanged()
  }

  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.queueLedgerCatalogReconciliation()
    super.notifyWorktreeFolderRenamed(repoId, oldWorktreeId, newWorktreeId)
  }

  protected withLedgerCatalogRemoval<T>(
    removal: LedgerCatalogRemovalTarget,
    expectedLedgers: ExpectedLedgerRevision[] | undefined,
    mutate: () => T
  ): Promise<LedgerCatalogRemovalResult<T>> {
    if (!this.ledgerService) {
      return super.withLedgerCatalogRemoval(removal, expectedLedgers, mutate)
    }
    return this.ledgerService.withCatalogRemoval(removal, expectedLedgers, mutate)
  }

  private queueLedgerCatalogReconciliation(): void {
    if (!this.ledgerService) {
      return
    }
    this.ledgerCatalogReconcileQueue = this.ledgerCatalogReconcileQueue
      .then(() => this.ledgerService!.reconcileCatalog())
      .catch((error) => {
        console.error('[ledger] catalog reconciliation failed', error)
      })
  }

  private async listLedgerWorktrees(): Promise<Worktree[]> {
    return this.listResolvedWorktrees()
  }

  private async resolveLedgerHost(
    workspaceId: string
  ): Promise<{ workspace: LedgerHostWorkspace; io: LedgerHostIo } | null> {
    const runtime = this as RuntimeCommandSurfaceHost<this>
    const worktree = (await this.listLedgerWorktrees()).find((item) => item.id === workspaceId)
    const folder = runtime
      .listFolderWorkspaces()
      .find((item) => item.id === workspaceId || folderWorkspaceKey(item.id) === workspaceId)
    const repo = worktree ? this.store?.getRepo(worktree.repoId) : undefined
    const rootPath = worktree?.path ?? folder?.folderPath
    if (!rootPath) {
      return null
    }
    const connectionId = repo?.connectionId ?? folder?.connectionId ?? null
    const provider = connectionId ? getSshFilesystemProvider(connectionId) : null
    const gitProvider = connectionId ? getSshGitProvider(connectionId) : null
    if (connectionId && (!provider || !gitProvider)) {
      return null
    }
    const remotePlatform = gitProvider?.getHostPlatform() ?? null
    const folderWslDistro =
      process.platform === 'win32' && !connectionId && folder
        ? parseWslUncPath(folder.folderPath)?.distro
        : undefined
    const localGitOptions =
      repo && !connectionId
        ? getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
        : { wslDistro: folderWslDistro }
    const localRootPath = toLocalWorktreeRuntimePath(rootPath, localGitOptions)
    const localAccess = getLocalWorktreePathAccess(localGitOptions)
    const workspace: LedgerHostWorkspace = {
      workspaceId,
      rootPath: localRootPath,
      host: connectionId ?? 'local',
      platform: remotePlatform
        ? isWindowsRemoteHost(remotePlatform)
          ? 'win32'
          : 'posix'
        : localGitOptions.wslDistro
          ? 'posix'
          : process.platform === 'win32'
            ? 'win32'
            : 'posix',
      ...(worktree?.projectId ? { projectId: worktree.projectId } : {}),
      ...(worktree?.branch ? { branch: worktree.branch } : {}),
      isGit: Boolean(worktree)
    }
    const io: LedgerHostIo = provider
      ? {
          readFile: async (path) => {
            const result: unknown = await provider.readFile(path)
            if (
              !result ||
              typeof result !== 'object' ||
              !('content' in result) ||
              typeof result.content !== 'string'
            ) {
              throw new Error('SSH file provider returned non-text content')
            }
            return result.content
          },
          listDirectory: async (path) =>
            (await provider.readDir(path)).map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory
            })),
          observeRevision: async () => {
            const result = await gitProvider!.exec(['rev-parse', 'HEAD'], rootPath)
            return result.stdout.trim() || null
          }
        }
      : {
          readFile: async (path) => {
            const content = await localAccess.readPath(
              toLocalWorktreeRuntimePath(path, localGitOptions)
            )
            if (typeof content !== 'string') {
              throw new Error('Local file reader returned non-text content')
            }
            return content
          },
          listDirectory: async (path) => {
            const runtimePath = toLocalWorktreeRuntimePath(path, localGitOptions)
            const fsPath =
              process.platform === 'win32' && localGitOptions.wslDistro
                ? toWindowsWslPath(runtimePath, localGitOptions.wslDistro)
                : runtimePath
            return (await readdir(fsPath, { withFileTypes: true })).map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory()
            }))
          },
          observeRevision: async () => {
            try {
              const result = await gitExecFileAsync(['rev-parse', 'HEAD'], {
                cwd: rootPath,
                ...localGitOptions
              })
              return result.stdout.trim() || null
            } catch {
              return null
            }
          }
        }
    return { workspace, io }
  }

  private async normalizeLedgerLocationForUi(location: LedgerLocation): Promise<LedgerLocation> {
    const runtime = this as RuntimeCommandSurfaceHost<this>
    const repos = this.listRepos()
    const project =
      location.base.kind === 'project'
        ? runtime.listProjects().find((item) => item.id === location.base.id)
        : undefined
    if (location.base.kind === 'project' && !project) {
      throw new LedgerError('owner-missing', 'Location project is not live')
    }
    const candidates =
      location.base.kind === 'project'
        ? repos.filter((repo) => project!.sourceRepoIds.includes(repo.id))
        : []
    if (location.base.kind === 'workspace') {
      const resolved = await this.resolveLedgerHost(location.base.id)
      if (!resolved) {
        throw new LedgerError('workspace-missing', 'Location workspace is not live')
      }
      if (location.base.host && location.base.host !== resolved.workspace.host) {
        throw new LedgerError('workspace-missing', 'Location host is not registered')
      }
      return normalizeLedgerLocation(location, {
        base: { kind: 'workspace', id: location.base.id, host: resolved.workspace.host },
        rootPath: resolved.workspace.rootPath,
        platform: resolved.workspace.platform,
        host: resolved.workspace.host
      })
    }
    if (!candidates.length) {
      throw new LedgerError('owner-missing', 'Location project has no registered source repository')
    }
    const hosts = [...new Set(candidates.map((repo) => repo.connectionId ?? 'local'))]
    if (location.base.host && !hosts.includes(location.base.host)) {
      throw new LedgerError('workspace-missing', 'Location host is not registered')
    }
    if (!location.base.host && hosts.length > 1) {
      throw new LedgerError('owner-ambiguous', 'Location project host is ambiguous')
    }
    const host = location.base.host ?? hosts[0]
    const scoped = candidates.filter((repo) => (repo.connectionId ?? 'local') === host)
    const contexts = scoped.map((repo) => {
      const connectionId = repo.connectionId ?? null
      const gitProvider = connectionId ? getSshGitProvider(connectionId) : null
      const remotePlatform = gitProvider?.getHostPlatform()
      if (connectionId && !remotePlatform) {
        throw new LedgerError('workspace-missing', 'Location host platform is unavailable')
      }
      const localGitOptions = !connectionId
        ? getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
        : undefined
      const platform = remotePlatform
        ? isWindowsRemoteHost(remotePlatform)
          ? ('win32' as const)
          : ('posix' as const)
        : localGitOptions?.wslDistro
          ? ('posix' as const)
          : process.platform === 'win32'
            ? ('win32' as const)
            : ('posix' as const)
      return { repo, rootPath: toLocalWorktreeRuntimePath(repo.path, localGitOptions), platform }
    })
    const absolute = contexts.find(
      (context) =>
        !normalizeLedgerLocation(location, {
          base: { kind: 'project', id: project!.id, host },
          rootPath: context.rootPath,
          platform: context.platform,
          host
        }).external
    )
    const selected = absolute ?? contexts[0]
    return normalizeLedgerLocation(location, {
      base: { kind: 'project', id: project!.id, host },
      rootPath: selected.rootPath,
      platform: selected.platform,
      host
    })
  }

  executeLedgerRequest(
    request: LedgerRequest,
    evidence?: OrchestrationCompatibilityEvidence
  ): Promise<LedgerResponse> {
    if (!this.ledgerService) {
      return Promise.reject(new Error('runtime_unavailable'))
    }
    return this.ledgerService.executeLedgerRequest(request, evidence)
  }

  executeLedgerUiRequest(request: LedgerRequest): Promise<LedgerResponse> {
    if (!this.ledgerService) {
      return Promise.reject(new Error('runtime_unavailable'))
    }
    return this.ledgerService.executeLedgerUiRequest(request)
  }
}
