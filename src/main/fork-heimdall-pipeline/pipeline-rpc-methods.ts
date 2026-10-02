import { parseExecutionHostId } from '../../shared/execution-host'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { defineMethod } from '../runtime/rpc/core'
import { isLocalArtifactPasswordCaller } from '../runtime/rpc/methods/fork-artifact-passwords/artifact-password-local-caller'
import { requireHeimdallObjectiveStore } from '../runtime/rpc/methods/fork-heimdall-objective/objective-binding'
import {
  requireHeimdallKernel,
  requireHeimdallTransport
} from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import {
  requireRuntimeGitProvider,
  runtimeGitRouteForTarget
} from '../runtime/runtime-git-command-target'
import { HEIMDALL_CHANNELS, type WatcherTarget } from '../../shared/fork-heimdall/api'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import { remoteReaderSchema } from '../../shared/fork-heimdall/remote-reader-schemas'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import {
  PipelineEnsureTrackedRequestSchema,
  PipelineEnsureTrackedResponseSchema,
  PipelineListRequestSchema,
  PipelineListResponseSchema,
  PipelinePersonalRequestSchema,
  PipelinePersonalResponseSchema,
  PipelineResolveRequestSchema,
  PipelineResolveResponseSchema,
  PipelineRunViewRequestSchema,
  type PipelineEnsureTrackedRequest,
  type PipelineEnsureTrackedResponse
} from '../../shared/fork-heimdall-pipeline/rpc-schemas'
import type { PipelineProfileStore, PipelineWorkspaceFileTarget } from './pipeline-files'
import { PipelineRunViewSchema } from '../../shared/fork-heimdall-pipeline/run-view-types'
import { ensurePipelineTracked, reincludePipelineFiles } from './pipeline-tracking'
import { requireHeimdallPipeline } from './pipeline-binding'
import {
  listPipelineFiles,
  personalPipelineOperation,
  resolvePipelineFile,
  resolvePipelineWorkspaceFileTarget
} from './pipeline-files'
import { projectPipelineRunView } from './run-view-projection'

const PipelineRunViewReaderSchema = remoteReaderSchema(PipelineRunViewSchema)

type RuntimeGitTargetResolver = {
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
}

function isRuntimeGitTargetResolver(runtime: unknown): runtime is RuntimeGitTargetResolver {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    'resolveRuntimeGitTarget' in runtime &&
    typeof runtime.resolveRuntimeGitTarget === 'function'
  )
}

function pairedRuntimeIdentity(
  store: PipelineProfileStore,
  executionHostId: string
): { id: string; pairingRevision: number } | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  const environment = resolveEnvironment(store.getProfileStorageDirectory(), host.environmentId)
  return {
    id: environment.id,
    pairingRevision: environment.pairingRevision ?? environment.createdAt
  }
}

async function readRemotePipelineMethod(
  runtime: OrcaRuntimeService,
  identity: { id: string; pairingRevision: number },
  method: string,
  params: unknown
): Promise<unknown> {
  const response = await requireHeimdallTransport(runtime).readRemote(identity, method, params)
  if (response.ok !== true) {
    throw new Error(`The owning runtime refused ${method}: ${response.error.message}`)
  }
  return response.result
}

async function listLiveWatcherIds(runtime: OrcaRuntimeService): Promise<Set<string>> {
  const fleet = await requireHeimdallKernel(runtime).fleet()
  return new Set(
    fleet.entries
      .filter((entry) => entry.entry.enrollment.terminalAtMs === null)
      .map((entry) => entry.target.watcherId)
  )
}

async function readLocalRunView(runtime: OrcaRuntimeService, target: WatcherTarget) {
  const detail = await requireHeimdallKernel(runtime).detail({
    watcherId: target.watcherId,
    connectionId: null,
    pairingRevision: null
  })
  const entry = detail.watcher.entry
  const { pipelineStore } = requireHeimdallPipeline(runtime)
  const facts = pipelineStore.facts(entry.enrollment.watcherId)
  const pipelineSource =
    entry.enrollment.kind === 'objective' || entry.enrollment.kind === 'hosted-review'
      ? (pipelineStore.runSource(entry.enrollment.watcherId) ?? undefined)
      : undefined
  const objectiveDetail =
    entry.enrollment.kind === 'objective'
      ? requireHeimdallObjectiveStore(runtime).detail(
          entry.enrollment.watcherId,
          ObjectiveEnrollmentPayloadSchema.parse(entry.enrollment.kindPayload),
          detail.ledger
        )
      : undefined
  const unverifiableDispatchIds = new Set<string>()
  if (entry.status.phase === 'worker-unverifiable') {
    for (const worker of detail.workers) {
      if (worker.liveness === 'live' || worker.liveness === 'unverifiable') {
        unverifiableDispatchIds.add(worker.dispatchId)
      }
    }
    const runningDispatchIds = new Set<string>()
    for (const attempt of getInFlightAttempts(detail.ledger)) {
      if (attempt.dispatchId) {
        runningDispatchIds.add(attempt.dispatchId)
      }
    }
    for (const dispatch of facts.dispatches) {
      if (runningDispatchIds.has(dispatch.dispatchId)) {
        unverifiableDispatchIds.add(dispatch.dispatchId)
      }
    }
  }
  return projectPipelineRunView({
    entry,
    ledger: detail.ledger,
    facts,
    ...(objectiveDetail === undefined ? {} : { objectiveDetail }),
    workers: detail.workers,
    ...(pipelineSource === undefined ? {} : { pipelineSource }),
    nowMs: Date.now(),
    unverifiableDispatchIds
  })
}

async function readRemoteRunView(runtime: OrcaRuntimeService, target: WatcherTarget) {
  if (target.connectionId === null) {
    throw new Error('A remote Heimdall run view requires an owning runtime target')
  }
  const pairingRevision = target.pairingRevision
  if (pairingRevision === null) {
    throw new Error('A remote Heimdall run view requires a pairing revision')
  }
  const response = await requireHeimdallTransport(runtime).readRemote(
    { id: target.connectionId, pairingRevision },
    HEIMDALL_CHANNELS.pipelineRunView,
    {
      target: {
        watcherId: target.watcherId,
        connectionId: null,
        pairingRevision: null
      }
    }
  )
  if (response.ok !== true) {
    throw new Error(`The owning runtime refused the pipeline run view: ${response.error.message}`)
  }
  return PipelineRunViewReaderSchema.parse(response.result)
}

/** Ensures repository pipelines are Git-visible while leaving folder workspaces unmodified. */
export async function ensurePipelineTrackedForWorkspace(input: {
  runtime: unknown
  store: PipelineProfileStore
  request: PipelineEnsureTrackedRequest
  resolvedWorkspace?: PipelineWorkspaceFileTarget
}): Promise<PipelineEnsureTrackedResponse> {
  const fileTarget =
    input.resolvedWorkspace ??
    (await resolvePipelineWorkspaceFileTarget(input.runtime, input.store, input.request.workspace))
  if (fileTarget.workspaceKind === 'folder') {
    return { status: 'tracked' }
  }
  if (fileTarget.workspaceKind === 'unknown') {
    throw new Error('Pipeline workspace type could not be resolved')
  }
  if (!isRuntimeGitTargetResolver(input.runtime)) {
    throw new Error('Runtime cannot resolve Git pipeline workspaces')
  }
  const gitTarget = await input.runtime.resolveRuntimeGitTarget(
    `id:${fileTarget.target.worktree.id}`
  )
  if (
    gitTarget.worktree.id !== fileTarget.target.worktree.id ||
    gitTarget.worktree.repoId !== input.request.workspace.repoId ||
    gitTarget.worktree.path !== fileTarget.target.worktree.path ||
    gitTarget.executionHostId !== fileTarget.target.executionHostId
  ) {
    throw new Error('Resolved Git pipeline workspace changed during tracking')
  }
  const route = runtimeGitRouteForTarget(gitTarget)
  if (route.kind === 'ssh') {
    requireRuntimeGitProvider(gitTarget)
  }
  const trackingTarget = {
    repoPath: gitTarget.repo?.path ?? gitTarget.worktree.path,
    worktreePath: gitTarget.worktree.path,
    connectionId: route.kind === 'ssh' ? route.connectionId : null,
    pipelineId: input.request.pipelineId
  }
  const result = await ensurePipelineTracked(trackingTarget)
  if (result.status !== 'still-ignored' || input.request.reinclude !== true) {
    return result
  }
  return reincludePipelineFiles(trackingTarget)
}

export const PIPELINE_RPC_METHODS = [
  defineMethod({
    name: HEIMDALL_CHANNELS.pipelineList,
    params: PipelineListRequestSchema,
    handler: async (request, context) => {
      const binding = requireHeimdallPipeline(context.runtime)
      const resolvedWorkspace = await resolvePipelineWorkspaceFileTarget(
        context.runtime,
        binding.store,
        request.workspace
      )
      const identity = pairedRuntimeIdentity(
        binding.store,
        resolvedWorkspace.target.executionHostId
      )
      if (identity) {
        return PipelineListResponseSchema.parse(
          await readRemotePipelineMethod(
            context.runtime,
            identity,
            HEIMDALL_CHANNELS.pipelineList,
            request
          )
        )
      }
      const response = await listPipelineFiles({
        runtime: context.runtime,
        store: binding.store,
        pipelineStore: binding.pipelineStore,
        workspace: request.workspace,
        resolvedWorkspace,
        liveWatcherIds: await listLiveWatcherIds(context.runtime),
        includePersonal: context.clientKind !== 'runtime'
      })
      return PipelineListResponseSchema.parse(response)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.pipelineResolve,
    params: PipelineResolveRequestSchema,
    handler: async (request, context) => {
      const { store } = requireHeimdallPipeline(context.runtime)
      const resolvedWorkspace = await resolvePipelineWorkspaceFileTarget(
        context.runtime,
        store,
        request.workspace
      )
      const identity = pairedRuntimeIdentity(store, resolvedWorkspace.target.executionHostId)
      if (identity) {
        return PipelineResolveResponseSchema.parse(
          await readRemotePipelineMethod(
            context.runtime,
            identity,
            HEIMDALL_CHANNELS.pipelineResolve,
            request
          )
        )
      }
      const response = await resolvePipelineFile({
        runtime: context.runtime,
        store,
        workspace: request.workspace,
        ref: request.ref,
        allowPersonal: context.clientKind !== 'runtime',
        resolvedWorkspace
      })
      return PipelineResolveResponseSchema.parse(response)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.pipelinePersonal,
    params: PipelinePersonalRequestSchema,
    handler: async (request, context) => {
      if (!isLocalArtifactPasswordCaller(context)) {
        throw new Error('Personal pipelines are served only by the local runtime')
      }
      const { store } = requireHeimdallPipeline(context.runtime)
      return PipelinePersonalResponseSchema.parse(await personalPipelineOperation(store, request))
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.pipelineEnsureTracked,
    params: PipelineEnsureTrackedRequestSchema,
    handler: async (request, context) => {
      const { store } = requireHeimdallPipeline(context.runtime)
      const resolvedWorkspace = await resolvePipelineWorkspaceFileTarget(
        context.runtime,
        store,
        request.workspace
      )
      const identity = pairedRuntimeIdentity(store, resolvedWorkspace.target.executionHostId)
      if (identity) {
        return PipelineEnsureTrackedResponseSchema.parse(
          await readRemotePipelineMethod(
            context.runtime,
            identity,
            HEIMDALL_CHANNELS.pipelineEnsureTracked,
            request
          )
        )
      }
      const result = await ensurePipelineTrackedForWorkspace({
        runtime: context.runtime,
        store,
        request,
        resolvedWorkspace
      })
      return PipelineEnsureTrackedResponseSchema.parse(result)
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.pipelineRunView,
    params: PipelineRunViewRequestSchema,
    handler: async ({ target }, context) => {
      if (
        context.clientKind === 'runtime' &&
        !isLocalArtifactPasswordCaller(context) &&
        target.connectionId !== null
      ) {
        throw new Error('A remote runtime can only serve locally owned Heimdall pipeline runs')
      }
      if (target.connectionId !== null && target.pairingRevision !== null) {
        return readRemoteRunView(context.runtime, target)
      }
      if (target.connectionId === null && target.pairingRevision === null) {
        return readLocalRunView(context.runtime, target)
      }
      throw new Error('Invalid remote Heimdall pipeline run target')
    }
  })
] as const
