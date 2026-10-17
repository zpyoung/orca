import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { agentHookServer } from '../agent-hooks/server'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { Store } from '../persistence'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshConnection } from '../ssh/ssh-connection'
import { shellEscape } from '../ssh/ssh-connection-utils'
import { execCommand } from '../ssh/ssh-relay-exec-command'
import { getRegisteredSshState, getSshConnectionManager } from '../ssh/ssh-target-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { bindLoopService } from '../runtime/rpc/methods/fork-loops/service-binding'
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
import { createLocalLoopFilesystem, type LoopGitRunner } from './loop-notes-file'
import { notifyLoop } from './loop-notify'
import { LoopService } from './loop-service'
import { LoopStore } from './loop-store'
import {
  createLoopSessionTotalsReader,
  readUsageLimit,
  readUsageTotals,
  type LoopUsageDeps
} from './loop-usage'

export function beginLoopsShutdown(service: LoopService | null): Promise<void> {
  return service?.shutdown() ?? Promise.resolve()
}

const SSH_GIT_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const SSH_GIT_TIMEOUT_MS = 120_000

/** One POSIX shell line that runs git in `cwd` with `env` set for that command only. */
export function buildSshGitCommand(
  cwd: string,
  args: string[],
  env: Record<string, string>
): string {
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!SSH_GIT_ENV_KEY.test(key)) {
      throw new Error(`Invalid environment variable name: ${JSON.stringify(key)}`)
    }
    return `${key}=${shellEscape(value)}`
  })
  const invocation = ['git', ...args.map(shellEscape)].join(' ')
  return `cd ${shellEscape(cwd)} && ${assignments.length > 0 ? `env ${assignments.join(' ')} ` : ''}${invocation}`
}

type SshGitConnection = Pick<SshConnection, 'exec' | 'usesSystemSshTransport'>

/**
 * Git over the SSH shell route, the one transport that can carry the snapshot's temporary
 * `GIT_INDEX_FILE`. Refuses Windows hosts because the command line is POSIX-quoted.
 */
export function createSshShellGitRunner(args: {
  connectionId: string
  cwd: string
  remotePlatform: string | undefined
  getConnection?: () => SshGitConnection | null
}): LoopGitRunner {
  const getConnection =
    args.getConnection ??
    (() => {
      const connection = getSshConnectionManager()?.getConnection(args.connectionId)
      return connection?.getState().status === 'connected' ? connection : null
    })
  return async (gitArgs, options) => {
    if (args.remotePlatform === 'win32') {
      throw new Error('Loop git commands do not support the Windows SSH command dialect.')
    }
    const connection = getConnection()
    if (!connection) {
      throw new Error('SSH target is not connected.')
    }
    let stderr = ''
    const stdout = await execCommand(
      connection,
      buildSshGitCommand(args.cwd, gitArgs, options?.env ?? {}),
      {
        timeoutMs: SSH_GIT_TIMEOUT_MS,
        onStderr: (chunk) => {
          stderr = chunk
        }
      }
    )
    return { stdout, stderr }
  }
}

type LoopTargetRuntime = {
  showManagedWorktree(
    selector: string
  ): Promise<{ repoId: string; path: string; hostId?: string | null }>
}

export async function resolveLoopTargets(
  runtime: LoopTargetRuntime,
  store: Pick<Store, 'getRepo' | 'getRepos'>,
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
  const remotePlatform = getRegisteredSshState(host.targetId)?.remotePlatform
  const shellGit = createSshShellGitRunner({
    connectionId: host.targetId,
    cwd: path,
    remotePlatform
  })
  return {
    executionHostId,
    check: {
      type: 'ssh',
      cwd: path,
      connectionId: host.targetId,
      remotePlatform
    },
    workspace: {
      kind,
      workspacePath: path,
      pathFlavor: 'posix',
      fs,
      // the provider's git.exec cannot pass env, so calls that need a private index use the shell route
      runGit:
        kind === 'git' && git
          ? async (args, options) => (options?.env ? shellGit(args, options) : git.exec(args, path))
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
    runCheck: (config, target, signal) => runLoopCheck({ config }, target, undefined, signal),
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
