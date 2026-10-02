import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isENOENT } from '../ipc/filesystem-auth'
import type { IFilesystemProvider } from '../providers/types'
import { requireRuntimeFileProvider } from '../runtime/runtime-file-command-target'
import type { ResolvedRuntimeFileTarget } from '../runtime/runtime-file-command-target'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'
import type { Store } from '../persistence'
import { isFolderRepo } from '../../shared/repo-kind'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  BUILTIN_PIPELINE_TEXTS,
  type BuiltinPipelineId
} from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import type {
  PipelineListResponse,
  PipelinePersonalRequest,
  PipelinePersonalResponse,
  PipelineResolveResponse,
  PipelineWorkspaceSelector
} from '../../shared/fork-heimdall-pipeline/rpc-schemas'
import type { PipelineDocument } from '../../shared/fork-heimdall-pipeline/document-schema'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineRef } from '../../shared/fork-heimdall-pipeline/pipeline-ref'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  validatePipeline,
  type PipelineValidationError
} from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { PipelineStore } from './pipeline-store'

const MAX_PIPELINE_SOURCE_BYTES = 256 * 1024
const PIPELINE_FILE_PATTERN = /^([a-z][a-z0-9-]{0,62})\.yaml$/u

export type PipelineProfileStore = Pick<Store, 'getProfileStorageDirectory' | 'getRepo'>
type RuntimeFileTargetResolver = {
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}

export type PipelineWorkspaceFileTarget = {
  target: ResolvedRuntimeFileTarget
  workspaceKind: 'git' | 'folder' | 'unknown'
}

type PipelineFileData = {
  ref: string
  scope: 'builtin' | 'repo' | 'user'
  id: string
  sourceText: string
  layoutText: string | null
  document: PipelineDocument | null
  contentHash: string | null
  errors: PipelineValidationError[]
  name: string
}

function isRuntimeFileTargetResolver(runtime: unknown): runtime is RuntimeFileTargetResolver {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    'resolveRuntimeFileTarget' in runtime &&
    typeof runtime.resolveRuntimeFileTarget === 'function'
  )
}

function worktreePath(target: ResolvedRuntimeFileTarget, relativePath: string): string {
  return target.executionHostId === 'local'
    ? join(target.worktree.path, relativePath)
    : joinWorktreeRelativePath(target.worktree.path, relativePath)
}

function personalPipelineDirectory(store: PipelineProfileStore): string {
  return join(store.getProfileStorageDirectory(), 'pipelines')
}

function personalPipelinePath(store: PipelineProfileStore, id: string): string {
  return join(personalPipelineDirectory(store), `${id}.yaml`)
}

function personalLayoutPath(store: PipelineProfileStore, id: string): string {
  return join(personalPipelineDirectory(store), `${id}.layout.json`)
}

function repoPipelinePath(target: ResolvedRuntimeFileTarget, id: string): string {
  return worktreePath(target, `.orca/pipelines/${id}.yaml`)
}

function repoLayoutPath(target: ResolvedRuntimeFileTarget, id: string): string {
  return worktreePath(target, `.orca/pipelines/${id}.layout.json`)
}

async function readTextFile(
  filePath: string,
  provider: IFilesystemProvider | null
): Promise<string> {
  if (provider) {
    const result = await provider.readFile(filePath, { maxTextBytes: MAX_PIPELINE_SOURCE_BYTES })
    if (result.isBinary) {
      throw new Error('Pipeline files must be text')
    }
    return result.content
  }
  const fileStat = await stat(filePath)
  if (fileStat.size > MAX_PIPELINE_SOURCE_BYTES) {
    throw new Error('Pipeline file exceeds the 256 KiB limit')
  }
  return readFile(filePath, 'utf8')
}

async function readOptionalTextFile(
  filePath: string,
  provider: IFilesystemProvider | null
): Promise<string | null> {
  try {
    return await readTextFile(filePath, provider)
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}

function parsePipelineData(input: {
  ref: string
  scope: PipelineFileData['scope']
  id: string
  sourceText: string
  layoutText: string | null
  workspaceKind: PipelineWorkspaceFileTarget['workspaceKind']
}): PipelineFileData {
  const parsed = parsePipelineText(input.sourceText)
  const errors: PipelineValidationError[] = [...parsed.errors]
  if (parsed.document !== null) {
    errors.push(
      ...validatePipeline(parsed.document, {
        workspaceKind: input.workspaceKind,
        expectedId: input.id
      })
    )
  }
  return {
    ...input,
    document: parsed.document,
    contentHash: parsed.document === null ? null : pipelineContentHash(parsed.document),
    errors,
    name: parsed.document?.name ?? input.id
  }
}

/** Re-resolves a candidate workspace selector through the runtime's routed file authority. */
export async function resolvePipelineWorkspaceFileTarget(
  runtime: unknown,
  store: PipelineProfileStore,
  workspace: PipelineWorkspaceSelector
): Promise<PipelineWorkspaceFileTarget> {
  if (!isRuntimeFileTargetResolver(runtime)) {
    throw new Error('Runtime cannot resolve Heimdall pipeline workspaces')
  }
  const repo = store.getRepo(workspace.repoId)
  const selector =
    workspace.worktreeId !== null
      ? `id:${workspace.worktreeId}`
      : repo
        ? `id:${repo.id}::${repo.path}`
        : null
  if (selector === null) {
    throw new Error('Pipeline workspace is unavailable')
  }
  const target = await runtime.resolveRuntimeFileTarget(selector)
  if (target.worktree.repoId !== workspace.repoId) {
    throw new Error('Resolved pipeline workspace does not match the requested repository')
  }
  const folderKey = parseWorkspaceKey(target.worktree.id)
  const workspaceKind =
    folderKey?.type === 'folder'
      ? 'folder'
      : repo === undefined
        ? 'unknown'
        : isFolderRepo(repo)
          ? 'folder'
          : 'git'
  return { target, workspaceKind }
}

async function listPipelineIds(
  directory: string,
  provider: IFilesystemProvider | null
): Promise<string[]> {
  try {
    if (provider) {
      const entries = await provider.readDir(directory)
      return entries
        .filter((entry) => !entry.isDirectory && !entry.isSymlink)
        .map((entry) => PIPELINE_FILE_PATTERN.exec(entry.name)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort()
    }
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => PIPELINE_FILE_PATTERN.exec(entry.name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort()
  } catch (error) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }
}

async function readRepositoryPipeline(input: {
  target: ResolvedRuntimeFileTarget
  id: string
  workspaceKind: PipelineWorkspaceFileTarget['workspaceKind']
}): Promise<PipelineFileData> {
  const provider = requireRuntimeFileProvider(input.target)
  const sourceText = await readTextFile(repoPipelinePath(input.target, input.id), provider)
  const layoutText = await readOptionalTextFile(repoLayoutPath(input.target, input.id), provider)
  return parsePipelineData({
    ref: input.id,
    scope: 'repo',
    id: input.id,
    sourceText,
    layoutText,
    workspaceKind: input.workspaceKind
  })
}

async function readPersonalPipelineData(
  store: PipelineProfileStore,
  id: string,
  workspaceKind: PipelineWorkspaceFileTarget['workspaceKind']
): Promise<PipelineFileData> {
  const sourceText = await readTextFile(personalPipelinePath(store, id), null)
  const layoutText = await readOptionalTextFile(personalLayoutPath(store, id), null)
  return parsePipelineData({
    ref: `user:${id}`,
    scope: 'user',
    id,
    sourceText,
    layoutText,
    workspaceKind
  })
}

function isBuiltinPipelineId(id: string): id is BuiltinPipelineId {
  return id === 'objective' || id === 'pr-sitter'
}

function builtinPipelineData(id: BuiltinPipelineId): PipelineFileData {
  return parsePipelineData({
    ref: `builtin:${id}`,
    scope: 'builtin',
    id,
    sourceText: BUILTIN_PIPELINE_TEXTS[id],
    layoutText: null,
    workspaceKind: 'unknown'
  })
}

function listItem(
  data: PipelineFileData,
  pipelineStore: Pick<PipelineStore, 'liveRunsForRef'>,
  liveWatcherIds: ReadonlySet<string>
) {
  return {
    ref: data.ref,
    scope: data.scope,
    id: data.id,
    name: data.name,
    valid: data.errors.length === 0,
    errorCount: data.errors.length,
    contentHash: data.contentHash,
    liveRuns: pipelineStore.liveRunsForRef(data.ref, liveWatcherIds).map((run) => ({
      watcherId: run.watcherId,
      runNumber: run.runNumber,
      contentHash: run.contentHash
    }))
  }
}

/** Lists workspace, built-in, and optionally local-profile pipelines without treating paths as refs. */
export async function listPipelineFiles(input: {
  runtime: unknown
  store: PipelineProfileStore
  pipelineStore: Pick<PipelineStore, 'liveRunsForRef'>
  workspace: PipelineWorkspaceSelector
  liveWatcherIds: ReadonlySet<string>
  includePersonal: boolean
  resolvedWorkspace?: PipelineWorkspaceFileTarget
}): Promise<PipelineListResponse> {
  const resolved =
    input.resolvedWorkspace ??
    (await resolvePipelineWorkspaceFileTarget(input.runtime, input.store, input.workspace))
  const provider = requireRuntimeFileProvider(resolved.target)
  const repositoryIds = await listPipelineIds(
    worktreePath(resolved.target, '.orca/pipelines'),
    provider
  )
  const entries = [
    builtinPipelineData('objective'),
    builtinPipelineData('pr-sitter'),
    ...(await Promise.all(
      repositoryIds.map((id) =>
        readRepositoryPipeline({
          target: resolved.target,
          id,
          workspaceKind: resolved.workspaceKind
        })
      )
    )),
    ...(input.includePersonal
      ? await Promise.all(
          (await listPipelineIds(personalPipelineDirectory(input.store), null)).map((id) =>
            readPersonalPipelineData(input.store, id, resolved.workspaceKind)
          )
        )
      : [])
  ]
  return {
    pipelines: entries.map((entry) => listItem(entry, input.pipelineStore, input.liveWatcherIds))
  }
}

/** Resolves a built-in, repository or local personal pipeline and returns its source plus diagnostics. */
export async function resolvePipelineFile(input: {
  runtime: unknown
  store: PipelineProfileStore
  workspace: PipelineWorkspaceSelector
  ref: string
  allowPersonal: boolean
  resolvedWorkspace?: PipelineWorkspaceFileTarget
}): Promise<PipelineResolveResponse> {
  const parsedRef = parsePipelineRef(input.ref)
  if ('error' in parsedRef) {
    throw new Error(parsedRef.error)
  }
  if (parsedRef.scope === 'builtin') {
    if (!isBuiltinPipelineId(parsedRef.id)) {
      throw new Error('Built-in pipeline does not exist')
    }
    return toResolveResponse(builtinPipelineData(parsedRef.id))
  }
  if (parsedRef.scope === 'user' && !input.allowPersonal) {
    throw new Error('Personal pipelines are served only by the local runtime')
  }
  const resolved =
    input.resolvedWorkspace ??
    (await resolvePipelineWorkspaceFileTarget(input.runtime, input.store, input.workspace))
  if (parsedRef.scope === 'user') {
    return toResolveResponse(
      await readPersonalPipelineData(input.store, parsedRef.id, resolved.workspaceKind)
    )
  }
  if (parsedRef.scope !== 'repo' && parsedRef.scope !== 'path') {
    throw new Error('Pipeline reference is invalid')
  }
  const id =
    'path' in parsedRef ? PIPELINE_FILE_PATTERN.exec(basename(parsedRef.path))?.[1] : parsedRef.id
  if (!id) {
    throw new Error('Pipeline reference is invalid')
  }
  const data = await readRepositoryPipeline({
    target: resolved.target,
    id,
    workspaceKind: resolved.workspaceKind
  })
  return toResolveResponse(data)
}

function toResolveResponse(data: PipelineFileData): PipelineResolveResponse {
  return {
    ref: data.ref,
    scope: data.scope,
    id: data.id,
    sourceText: data.sourceText,
    layoutText: data.layoutText,
    document: data.document,
    contentHash: data.contentHash,
    errors: data.errors
  }
}

async function personalYamlSnapshot(
  store: PipelineProfileStore,
  id: string
): Promise<{ yamlText: string; signature: string } | null> {
  const filePath = personalPipelinePath(store, id)
  try {
    const before = await stat(filePath)
    if (before.size > MAX_PIPELINE_SOURCE_BYTES) {
      throw new Error('Pipeline file exceeds the 256 KiB limit')
    }
    const bytes = await readFile(filePath)
    const after = await stat(filePath)
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
      throw new Error('Pipeline file changed while being read')
    }
    return {
      yamlText: bytes.toString('utf8'),
      signature: `${after.mtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`
    }
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}

/** Serves profile-local pipeline files only to the local runtime. */
export async function personalPipelineOperation(
  store: PipelineProfileStore,
  request: PipelinePersonalRequest
): Promise<PipelinePersonalResponse> {
  if (request.op === 'list') {
    const ids = await listPipelineIds(personalPipelineDirectory(store), null)
    const pipelines = await Promise.all(
      ids.map(async (id) => ({
        id,
        name: (await readPersonalPipelineData(store, id, 'unknown')).name
      }))
    )
    return { pipelines }
  }
  const id = request.id
  if (request.op === 'read') {
    const snapshot = await personalYamlSnapshot(store, id)
    if (snapshot === null) {
      throw new Error('Pipeline file does not exist')
    }
    const layoutText = await readOptionalTextFile(personalLayoutPath(store, id), null)
    return { yamlText: snapshot.yamlText, layoutText, signature: snapshot.signature }
  }
  if (request.op === 'stat') {
    return { signature: (await personalYamlSnapshot(store, id))?.signature ?? null }
  }
  const current = (await personalYamlSnapshot(store, id))?.signature ?? null
  if (request.expectedSignature !== undefined && request.expectedSignature !== current) {
    return { status: 'conflict', current }
  }
  const yamlPath = personalPipelinePath(store, id)
  const layoutPath = personalLayoutPath(store, id)
  if (request.op === 'write') {
    await mkdir(personalPipelineDirectory(store), { recursive: true })
    await writeFile(yamlPath, request.yamlText, 'utf8')
    if (request.layoutText !== undefined) {
      if (request.layoutText === null) {
        try {
          await unlink(layoutPath)
        } catch (error) {
          if (!isENOENT(error)) {
            throw error
          }
        }
      } else {
        await writeFile(layoutPath, request.layoutText, 'utf8')
      }
    }
    const signature = (await personalYamlSnapshot(store, id))?.signature
    if (signature === undefined) {
      throw new Error('Pipeline file disappeared after writing')
    }
    return { status: 'written', signature }
  }
  if (current === null) {
    return { status: 'not-found', current: null }
  }
  await unlink(yamlPath)
  try {
    await unlink(layoutPath)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
  return { status: 'deleted', current: null }
}
