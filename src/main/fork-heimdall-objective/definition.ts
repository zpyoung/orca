import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ResolvedRuntimeFileTarget } from '../runtime/runtime-file-command-target'
import {
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveCapabilities,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import { OBJECTIVE_LANDING_LADDER } from '../../shared/fork-heimdall-objective/landing-ladder'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import { isFolderRepo } from '../../shared/repo-kind'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import { getAutomationSchedulerOwner } from '../persistence/scheduling-automations/automation-context-migration'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  defaultObjectiveForgeAccess,
  objectiveForgeContext,
  type ObjectiveForgeAccess
} from './objective-forge-access'

type ObjectiveRuntimeResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

export class ObjectiveOwnerNotExecutableError extends Error {
  readonly schedulerOwner: AutomationSchedulerOwner

  constructor(schedulerOwner: AutomationSchedulerOwner) {
    super(`Objective watcher owner is not executable: ${schedulerOwner}`)
    this.name = 'ObjectiveOwnerNotExecutableError'
    this.schedulerOwner = schedulerOwner
  }
}

function parseCapabilities(value: EnrollInput['capabilities']): ObjectiveCapabilities {
  const parsed = ObjectiveCapabilitiesSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(
      'Objective enrollment requires exactly plan, implement, review, check and land capabilities'
    )
  }
  return parsed.data
}

function assertRoleAgentsKnown(contract: ObjectiveEnrollmentPayload): void {
  for (const [role, agent] of Object.entries(contract.roleAgents)) {
    if (agent !== undefined && !isTuiAgent(agent)) {
      throw new Error(`Objective ${role} agent is unknown: ${agent}`)
    }
  }
}

function assertOwnerExecutable(
  owner: AutomationSchedulerOwner,
  storageAuthority: 'desktop' | 'runtime'
): void {
  if (
    (storageAuthority === 'desktop' && owner === 'remote_host_service') ||
    (storageAuthority === 'runtime' && owner !== 'local_host_service')
  ) {
    throw new ObjectiveOwnerNotExecutableError(owner)
  }
}

function schedulerOwnerFor(
  repo: Repo,
  executionHostId: ExecutionHostId,
  storageAuthority: 'desktop' | 'runtime'
): AutomationSchedulerOwner {
  const routeOwner = getAutomationSchedulerOwner({ ...repo, executionHostId })
  assertOwnerExecutable(routeOwner, storageAuthority)
  return storageAuthority === 'runtime' ? 'remote_host_service' : routeOwner
}

async function resolveGitWorkspace(
  runtime: ObjectiveRuntimeResolver,
  repoId: string,
  worktreeId: string
): Promise<{
  executionHostId: ExecutionHostId
  workspacePath: string
  gitTarget: RuntimeGitTarget
}> {
  const target = await runtime.resolveRuntimeGitTarget(`id:${worktreeId}`)
  const worktree = target.worktree
  if (worktree.id !== worktreeId || worktree.repoId !== repoId) {
    throw new Error('Invalid objective worktree identity')
  }
  if (!worktree.path || worktree.git.isBare || worktree.git.prunable) {
    throw new Error('Objective Git workspace is unavailable')
  }
  return {
    executionHostId: target.executionHostId,
    workspacePath: worktree.path,
    gitTarget: target
  }
}

async function resolveFolderWorkspace(
  runtime: ObjectiveRuntimeResolver,
  repo: Repo
): Promise<{
  executionHostId: ExecutionHostId
  workspacePath: string
  gitTarget?: never
}> {
  const target = await runtime.resolveRuntimeFileTarget(`id:${repo.id}::${repo.path}`)
  const worktree = target.worktree
  if (worktree.repoId !== repo.id || worktree.path !== repo.path) {
    throw new Error('Invalid objective folder workspace identity')
  }
  return { executionHostId: target.executionHostId, workspacePath: worktree.path }
}

/** Rebuilds every workspace and execution-host authority field from runtime/store state. */
export async function authorizeObjectiveEnrollment(
  runtime: OrcaRuntimeService,
  store: Store,
  input: EnrollInput,
  storageAuthority: 'desktop' | 'runtime' = 'desktop',
  forge: ObjectiveForgeAccess = defaultObjectiveForgeAccess
): Promise<AuthorizedEnrollment> {
  if (input.kind !== 'objective') {
    throw new Error('Objective enrollment requires the objective kind')
  }
  const capabilities = parseCapabilities(input.capabilities)
  const candidate = ObjectiveEnrollmentPayloadSchema.parse(input.kindPayload)
  const repo = store.getRepo(input.repoId)
  if (!repo) {
    throw new Error('Objective repository is unavailable')
  }

  const folder = isFolderRepo(repo)
  const contract: ObjectiveEnrollmentPayload = {
    ...candidate,
    workspaceKind: folder ? 'folder' : 'git'
  }
  if (folder && contract.landingBar !== 'files-on-disk') {
    throw new Error('landing-bar-requires-git')
  }
  const requiresHostedReview =
    OBJECTIVE_LANDING_LADDER.indexOf(contract.landingBar) >=
    OBJECTIVE_LANDING_LADDER.indexOf('hosted-review')
  if (!folder && input.worktreeId === null && requiresHostedReview) {
    throw new Error('landing-bar-requires-worktree')
  }
  if (contract.maxConcurrency > 1) {
    throw new Error('max-concurrency-unsupported')
  }
  assertRoleAgentsKnown(contract)

  const resolver = runtime as unknown as ObjectiveRuntimeResolver
  const workspace = folder
    ? input.worktreeId === null
      ? await resolveFolderWorkspace(resolver, repo)
      : (() => {
          throw new Error('Folder objective enrollment cannot name a Git worktree')
        })()
    : input.worktreeId
      ? await resolveGitWorkspace(resolver, repo.id, input.worktreeId)
      : (() => {
          throw new Error('Git objective enrollment requires an explicit worktree')
        })()
  if (!folder && requiresHostedReview) {
    if (!workspace.gitTarget) {
      throw new Error('landing-bar-requires-worktree')
    }
    const provider = await forge.detectProvider(
      objectiveForgeContext({
        kind: 'git',
        executionHostId: workspace.executionHostId,
        workspacePath: workspace.workspacePath,
        fileProvider: null,
        gitTarget: workspace.gitTarget
      })
    )
    if (provider !== 'github' && provider !== 'gitlab') {
      throw new Error('landing-bar-requires-supported-forge')
    }
  }
  const schedulerOwner = schedulerOwnerFor(repo, workspace.executionHostId, storageAuthority)

  return {
    kind: 'objective',
    workspaceKey: `${workspace.executionHostId}::${workspace.workspacePath}`,
    executionHostId: workspace.executionHostId,
    repoId: repo.id,
    worktreeId: folder ? null : input.worktreeId,
    workspacePath: workspace.workspacePath,
    schedulerOwner,
    capabilities,
    budget: structuredClone(input.budget),
    kindPayload: contract
  }
}

export function objectiveContractFromEnrollment(
  enrollment: Pick<WatcherEnrollment, 'kind' | 'kindPayload'>
): ObjectiveEnrollmentPayload {
  if (enrollment.kind !== 'objective') {
    throw new Error('Enrollment is not an objective watcher')
  }
  return ObjectiveEnrollmentPayloadSchema.parse(enrollment.kindPayload)
}
