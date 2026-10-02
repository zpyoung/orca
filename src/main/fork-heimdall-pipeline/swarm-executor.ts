import { lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { hostScopeCensusIsComplete } from '../../shared/runtime-listing-host-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import {
  isObjectiveMetadataPath,
  type ObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import { resolveLeasePathFlavor } from '../fork-heimdall/lease-host-filesystem'
import {
  TaskListSchema,
  lintTaskList,
  type TaskListLintError,
  type TaskListWarning
} from '../../shared/fork-heimdall-pipeline/task-list'
import {
  childTaskIdFromInstanceId,
  nodeIdFromInstanceId
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineStore } from './pipeline-store'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { Worktree } from '../../shared/worktree/types'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'

const PIPELINE_CHILD_MARKER_PREFIX = 'heimdall-pipeline-dispatch:'
const MANAGED_WORKTREE_SCAN_LIMIT = 1_000
const CONFLICT_MARKER = /^(?:<{7,}(?:\s|$)|={7,}\s*$|>{7,}(?:\s|$)|\|{7,}(?:\s|$))/mu
const MAX_CONFLICT_TEXT_BYTES = 4 * 1024 * 1024

type PipelineWorktreeRuntime = Pick<
  OrcaRuntimeService,
  'createManagedWorktree' | 'listManagedWorktrees' | 'showManagedWorktree' | 'removeManagedWorktree'
>

export type ExpandSwarmInput = {
  watcherId: string
  swarmId: string
  epoch: number
  tasks: unknown
  runWorkspacePath: string
}

export type ExpandSwarmResult =
  | { status: 'expanded'; warnings: TaskListWarning[] }
  | { status: 'lint-failed'; errors: TaskListLintError[] }

/** Validates and records a swarm expansion against the run worktree's exact current HEAD. */
export async function expandSwarm(
  input: ExpandSwarmInput,
  deps: { store: PipelineStore; readHead(path: string): Promise<string> }
): Promise<ExpandSwarmResult> {
  const candidates = Array.isArray(input.tasks) ? input.tasks : [input.tasks]
  const lint = lintTaskList(candidates)
  if (lint.errors.length > 0) {
    return { status: 'lint-failed', errors: lint.errors }
  }

  const tasks = TaskListSchema.parse(candidates)
  const baseCommit = (await deps.readHead(input.runWorkspacePath)).trim()
  if (!isObjectiveGitObjectId(baseCommit)) {
    throw new Error('Run worktree HEAD is not a Git commit')
  }
  deps.store.recordSwarmExpansion({
    watcherId: input.watcherId,
    swarmId: input.swarmId,
    epoch: input.epoch,
    tasks,
    warnings: lint.warnings,
    baseCommit
  })
  return { status: 'expanded', warnings: lint.warnings }
}

export type PrepareChildWorktreeInput = {
  watcherId: string
  instanceId: string
  epoch: number
  repoId: string
  baseCommit: string
}

/** Produces the stable managed-worktree marker used for child recovery and safe cleanup. */
export function pipelineChildWorktreeMarker(
  input: Pick<PrepareChildWorktreeInput, 'watcherId' | 'instanceId' | 'epoch'>
): string {
  return `${PIPELINE_CHILD_MARKER_PREFIX}${input.watcherId}:${input.instanceId}:${input.epoch}`
}

function childWorktreeName(input: PrepareChildWorktreeInput): string {
  const identity = `${input.watcherId}\0${input.instanceId}\0${input.epoch}`
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 20)
  return `pipeline-child-${suffix}`
}

function headMatchesBase(
  worktree: { head?: string; git?: { head?: string } },
  baseCommit: string
): boolean {
  return worktree.git?.head === baseCommit || worktree.head === baseCommit
}

async function removeWorktree(runtime: PipelineWorktreeRuntime, worktreeId: string): Promise<void> {
  const removed = await runtime.removeManagedWorktree(`id:${worktreeId}`, {
    force: true,
    runHooks: false
  })
  if (removed.warning) {
    throw new Error(`Could not remove pipeline child worktree: ${removed.warning}`)
  }
}

function ensureBaseCommit(baseCommit: string): void {
  if (!isObjectiveGitObjectId(baseCommit)) {
    throw new Error('Pipeline child base must be a Git commit')
  }
}
function assertChildUsesExpansionBase(
  input: PrepareChildWorktreeInput,
  facts: Pick<PipelineStoreFacts, 'swarmExpansions'>
): void {
  const swarmId = nodeIdFromInstanceId(input.instanceId)
  const taskId = childTaskIdFromInstanceId(input.instanceId)
  const expansion = facts.swarmExpansions.find(
    (row) => row.swarmId === swarmId && row.epoch === input.epoch
  )
  if (
    taskId === null ||
    expansion === undefined ||
    expansion.baseCommit !== input.baseCommit ||
    !expansion.tasks.some((task) => task.id === taskId)
  ) {
    throw new Error('Pipeline child does not match its recorded swarm expansion')
  }
}

/** Creates or recovers an Orca-managed child worktree and records it only after its base is verified. */
export async function prepareChildWorktree(
  input: PrepareChildWorktreeInput,
  deps: { runtime: PipelineWorktreeRuntime; store: PipelineStore }
): Promise<{ worktreeId: string; workspacePath: string }> {
  ensureBaseCommit(input.baseCommit)
  const facts = deps.store.facts(input.watcherId)
  assertChildUsesExpansionBase(input, facts)
  const existing = facts.childWorktrees.find(
    (row) => row.instanceId === input.instanceId && row.epoch === input.epoch
  )
  const marker = pipelineChildWorktreeMarker(input)

  if (existing?.setupState === 'removed') {
    throw new Error('Pipeline child worktree was already cleaned up')
  }
  if (existing?.setupState === 'ready') {
    const worktree = await deps.runtime.showManagedWorktree(`id:${existing.worktreeId}`)
    if (worktree.id !== existing.worktreeId || worktree.comment !== marker) {
      throw new Error('Pipeline child worktree identity changed')
    }
    return { worktreeId: worktree.id, workspacePath: worktree.path }
  }
  if (existing) {
    const worktree = await deps.runtime.showManagedWorktree(`id:${existing.worktreeId}`)
    if (worktree.comment !== marker) {
      throw new Error('Pipeline child worktree identity changed')
    }
    await removeWorktree(deps.runtime, existing.worktreeId)
  } else {
    const listing = await deps.runtime.listManagedWorktrees(
      `id:${input.repoId}`,
      MANAGED_WORKTREE_SCAN_LIMIT
    )
    if (listing.truncated || !hostScopeCensusIsComplete(listing.hostScope)) {
      throw new Error('Pipeline child worktree recovery scan was incomplete')
    }
    const marked = listing.worktrees.filter((worktree) => worktree.comment === marker)
    if (marked.length > 1) {
      throw new Error('Multiple managed worktrees match this pipeline child')
    }
    const recovered = marked[0]
    if (recovered) {
      if (!headMatchesBase(recovered, input.baseCommit)) {
        await removeWorktree(deps.runtime, recovered.id)
        throw new Error('Recovered pipeline child worktree did not start at its recorded base')
      }
      deps.store.recordChildWorktree({
        watcherId: input.watcherId,
        instanceId: input.instanceId,
        epoch: input.epoch,
        worktreeId: recovered.id,
        setupState: 'ready'
      })
      return { worktreeId: recovered.id, workspacePath: recovered.path }
    }
  }

  const created = await deps.runtime.createManagedWorktree({
    repoSelector: `id:${input.repoId}`,
    name: childWorktreeName(input),
    baseBranch: input.baseCommit,
    comment: marker,
    displayName: `Pipeline child ${input.instanceId}`,
    displayNameKind: 'user',
    runHooks: false,
    setupDecision: 'run',
    awaitTerminalProvisioning: true,
    observeSetupCompletion: true,
    activate: false,
    lineage: { comment: marker }
  })
  if (!headMatchesBase(created.worktree, input.baseCommit)) {
    await removeWorktree(deps.runtime, created.worktree.id)
    throw new Error('Pipeline child worktree did not start at its recorded base')
  }
  deps.store.recordChildWorktree({
    watcherId: input.watcherId,
    instanceId: input.instanceId,
    epoch: input.epoch,
    worktreeId: created.worktree.id,
    setupState: 'ready'
  })
  return { worktreeId: created.worktree.id, workspacePath: created.worktree.path }
}
/** Removes only T14-marked child worktrees that have been applied or belong to a terminal run. */
export async function cleanupChildWorktrees(
  input: { watcherId: string; terminal: boolean },
  deps: {
    runtime: Pick<
      PipelineWorktreeRuntime,
      'showManagedWorktree' | 'removeManagedWorktree' | 'listManagedWorktrees'
    >
    store: PipelineStore
  }
): Promise<boolean> {
  const facts = deps.store.facts(input.watcherId)
  let clean = true
  for (const child of facts.childWorktrees) {
    if (child.setupState === 'removed') {
      continue
    }
    const applied = facts.mergeProgress.some(
      (row) =>
        row.childInstanceId === child.instanceId &&
        row.epoch === child.epoch &&
        row.state === 'applied'
    )
    if (!input.terminal && !applied) {
      continue
    }
    const marker = pipelineChildWorktreeMarker({
      watcherId: input.watcherId,
      instanceId: child.instanceId,
      epoch: child.epoch
    })
    let worktree: Worktree
    try {
      worktree = await deps.runtime.showManagedWorktree(`id:${child.worktreeId}`)
    } catch {
      const parsedId = splitWorktreeId(child.worktreeId)
      if (!parsedId) {
        clean = false
        continue
      }
      try {
        const listing = await deps.runtime.listManagedWorktrees(`id:${parsedId.repoId}`, 1_000)
        if (
          !listing.truncated &&
          hostScopeCensusIsComplete(listing.hostScope) &&
          !listing.worktrees.some(
            (candidate) => candidate.id === child.worktreeId || candidate.comment === marker
          )
        ) {
          deps.store.recordChildWorktree({
            watcherId: input.watcherId,
            instanceId: child.instanceId,
            epoch: child.epoch,
            worktreeId: child.worktreeId,
            setupState: 'removed'
          })
          continue
        }
      } catch {
        clean = false
        continue
      }
      clean = false
      continue
    }
    if (worktree.id !== child.worktreeId || worktree.comment !== marker) {
      clean = false
      continue
    }
    try {
      const removed = await deps.runtime.removeManagedWorktree(`id:${child.worktreeId}`, {
        force: true,
        runHooks: false,
        ...(worktree.hostId ? { hostId: worktree.hostId } : {})
      })
      if (removed.warning) {
        clean = false
        continue
      }
      deps.store.recordChildWorktree({
        watcherId: input.watcherId,
        instanceId: child.instanceId,
        epoch: child.epoch,
        worktreeId: child.worktreeId,
        setupState: 'removed'
      })
    } catch {
      clean = false
    }
  }
  return clean
}
type ConflictFile =
  | { status: 'text'; content: string }
  | { status: 'missing' }
  | { status: 'unreadable' }

function missingPathError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function safeConflictPath(path: string, target: ObjectiveWorkspaceTarget): boolean {
  const flavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  const parts = flavor === win32 ? path.split(/[\\/]/u) : path.split('/')
  return (
    path.length > 0 &&
    !path.includes('\0') &&
    !path.startsWith('/') &&
    !path.startsWith('\\') &&
    !/^[a-zA-Z]:/u.test(path) &&
    !parts.some((part) => part.length === 0 || part === '.' || part === '..') &&
    !isObjectiveMetadataPath(path, flavor === win32)
  )
}

async function readConflictFile(
  target: ObjectiveWorkspaceTarget,
  relativePath: string
): Promise<ConflictFile> {
  const flavor = resolveLeasePathFlavor(target.executionHostId, target.workspacePath)
  const parts = flavor === win32 ? relativePath.split(/[\\/]/u) : relativePath.split('/')
  let absolutePath = target.workspacePath
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (part === undefined) {
        return { status: 'unreadable' }
      }
      absolutePath = flavor.join(absolutePath, part)
      const isLast = index === parts.length - 1
      if (target.fileProvider) {
        if (!target.fileProvider.lstat) {
          return { status: 'unreadable' }
        }
        const stat = await target.fileProvider.lstat(absolutePath)
        if (stat.type === 'symlink') {
          return { status: 'unreadable' }
        }
        if (!isLast && stat.type !== 'directory') {
          return { status: 'missing' }
        }
        if (isLast && (stat.type !== 'file' || stat.size > MAX_CONFLICT_TEXT_BYTES)) {
          return { status: 'unreadable' }
        }
      } else {
        if (target.executionHostId !== 'local') {
          return { status: 'unreadable' }
        }
        const stat = await lstat(absolutePath)
        if (stat.isSymbolicLink()) {
          return { status: 'unreadable' }
        }
        if (!isLast && !stat.isDirectory()) {
          return { status: 'missing' }
        }
        if (isLast && (!stat.isFile() || stat.size > MAX_CONFLICT_TEXT_BYTES)) {
          return { status: 'unreadable' }
        }
      }
    }
    if (target.fileProvider) {
      const result = await target.fileProvider.readFile(absolutePath, {
        maxTextBytes: MAX_CONFLICT_TEXT_BYTES
      })
      return result.isBinary
        ? { status: 'unreadable' }
        : { status: 'text', content: result.content }
    }
    if (target.executionHostId !== 'local') {
      return { status: 'unreadable' }
    }
    return { status: 'text', content: await readFile(absolutePath, 'utf8') }
  } catch (error) {
    return missingPathError(error) ? { status: 'missing' } : { status: 'unreadable' }
  }
}
/** Verifies conflict-path contents on their execution host without following symlinks or reading locally. */
export async function verifyPipelineConflictFiles(
  target: ObjectiveWorkspaceTarget,
  conflictPaths: readonly string[]
): Promise<boolean> {
  for (const path of conflictPaths) {
    if (!safeConflictPath(path, target)) {
      return false
    }
    const file = await readConflictFile(target, path)
    if (file.status === 'unreadable') {
      return false
    }
    if (file.status === 'text' && CONFLICT_MARKER.test(file.content)) {
      return false
    }
  }
  return true
}
