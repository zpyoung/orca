import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { agentHookServer } from '../agent-hooks/server'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { Store } from '../persistence'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseWslPath } from '../wsl'
import { resolveWorktreeHostRouting } from '../runtime/worktree-launch-host-repo'
import { mainProcessState } from '../startup/main-process-state'
import { createInputAttribution } from './input-attribution'
import { createIterationObserver } from './iteration-observer'
import { runLoopCheck } from './loop-check'
import { LoopDatabase, LoopStoreError } from './loop-database'
import { diffSnapshots, snapshotWorkingTree } from './loop-diff'
import type { LoopEvidenceTools, LoopTargets } from './loop-driver'
import { evaluateIteration } from './loop-evaluator'
import { forwardLoopChangesToRenderer } from './loop-ipc-forward'
import { createLocalLoopFilesystem } from './loop-notes-file'
import { notifyLoop } from './loop-notify'
import { LoopService } from './loop-service'
import { LoopStore } from './loop-store'
import {
  createLoopSessionTotalsReader,
  readUsageLimit,
  readUsageTotals,
  type LoopUsageDeps
} from './loop-usage'

const loopServices = new WeakMap<OrcaRuntimeService, LoopService>()

export function bindLoopService(runtime: OrcaRuntimeService, service: LoopService): void {
  loopServices.set(runtime, service)
}

export function requireLoopService(runtime: OrcaRuntimeService): LoopService {
  const service = loopServices.get(runtime)
  if (!service) {
    throw new LoopStoreError('loop_runtime_unavailable', 'Loops are unavailable on this runtime')
  }
  return service
}

export function beginLoopsShutdown(service: LoopService | null): Promise<void> {
  return service?.shutdown() ?? Promise.resolve()
}

async function resolveLoopTargets(
  runtime: OrcaRuntimeService,
  store: Store,
  worktreeId: string
): Promise<LoopTargets> {
  const worktree = await runtime.showManagedWorktree(`id:${worktreeId}`)
  const repo = store.getRepo(worktree.repoId)
  const kind = repo && isFolderRepo(repo) ? 'folder' : 'git'
  const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
  const executionHostId = routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
  const host = parseExecutionHostId(executionHostId)
  const path: string = worktree.path
  if (!host || host.kind === 'runtime') {
    throw new LoopStoreError(
      'loop_check_unsupported_host',
      'Loops cannot run on a paired Orca runtime host.'
    )
  }
  if (host.kind === 'local') {
    const wslDistro = parseWslPath(path)?.distro
    return {
      executionHostId,
      check: { type: 'local', cwd: path },
      workspace: {
        kind,
        workspacePath: path,
        pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
        fs: createLocalLoopFilesystem(),
        runGit:
          kind === 'git'
            ? (args, options) =>
                gitExecFileAsync(args, {
                  cwd: path,
                  ...(wslDistro ? { wslDistro } : {}),
                  ...(options?.env ? { env: { ...process.env, ...options.env } } : {})
                })
            : null
      }
    }
  }
  const fs = getSshFilesystemProvider(host.targetId)
  const git = getSshGitProvider(host.targetId)
  if (!fs) {
    throw new Error('The SSH host is not connected.')
  }
  return {
    executionHostId,
    check: { type: 'ssh', cwd: path, connectionId: host.targetId, remotePlatform: undefined },
    workspace: {
      kind,
      workspacePath: path,
      pathFlavor: 'posix',
      fs,
      // the SSH git route cannot pass env, so private-index snapshots return null there
      runGit:
        kind === 'git' && git
          ? async (args, options) => {
              if (options?.env) {
                throw new Error('The SSH git route cannot pass environment variables.')
              }
              return git.exec(args, path)
            }
          : null
    }
  }
}

function createEvidenceTools(store: Store): LoopEvidenceTools {
  const usage: LoopUsageDeps = {
    isSshWorktree: (worktreeId) => {
      const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
      return Boolean(repo?.connectionId) || (repo?.executionHostId ?? '').startsWith('ssh:')
    },
    getProviderSessionIdentities: () => agentHookServer.getProviderSessionIdentities(),
    readSessionTotals: (args) =>
      createLoopSessionTotalsReader({
        claudeUsage: mainProcessState.claudeUsage,
        codexUsage: mainProcessState.codexUsage
      })(args)
  }
  return {
    snapshotTree: snapshotWorkingTree,
    diffTrees: diffSnapshots,
    runCheck: (config, target) => runLoopCheck({ config }, target),
    evaluate: evaluateIteration,
    readUsage: (paneKey, worktreeId, agent) => readUsageTotals(paneKey, worktreeId, agent, usage),
    readUsageLimit: (agent) =>
      readUsageLimit(agent, {
        getRateLimitState: () => {
          if (!mainProcessState.rateLimits) {
            throw new Error('Rate limits are not initialized')
          }
          return mainProcessState.rateLimits.getState()
        }
      })
  }
}

/** Builds the loop service for this runtime; the database opens on first use. */
export function startLoops(
  runtime: OrcaRuntimeService,
  store: Store,
  isServeMode: boolean
): LoopService {
  const database = new LoopDatabase(() => store.getProfileStorageDirectory())
  const inputAttribution = createInputAttribution(runtime)
  const service = new LoopService({
    store: new LoopStore(database),
    runtime,
    driverDeps: {
      observer: createIterationObserver({ runtime, hookSource: agentHookServer, inputAttribution }),
      inputAttribution,
      tools: createEvidenceTools(store),
      targets: (worktreeId) => resolveLoopTargets(runtime, store, worktreeId)
    },
    notify: (loop, event, detail) => notifyLoop(store, loop, event, detail),
    closeDatabase: () => database.close()
  })
  bindLoopService(runtime, service)
  if (!isServeMode) {
    forwardLoopChangesToRenderer(service)
  }
  return service
}
