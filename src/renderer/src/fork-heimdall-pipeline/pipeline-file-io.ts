import { NodeIdSchema } from '../../../shared/fork-heimdall-pipeline/node-id'
import {
  PipelineLayoutSchema,
  type PipelineLayout
} from '../../../shared/fork-heimdall-pipeline/layout-schema'
import { sha256 } from '../../../shared/sha256'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { useAppStore } from '@/store'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { joinPath, normalizeRelativePath } from '@/lib/path'
import {
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from '@/components/editor/editor-self-write-registry'
import {
  createRuntimePath,
  deleteRuntimePath,
  isMissingRuntimePathError,
  readRuntimeDirectory,
  readRuntimeFileContent,
  runtimePathExists,
  statRuntimePath,
  writeRuntimeFile,
  type RuntimeFileOperationArgs,
  type RuntimeFileReadArgs
} from '@/runtime/runtime-file-client'
import {
  applyPipelineEdits,
  type PipelineEdit
} from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import {
  usePipelineCanvasDraftStore,
  type PipelineDiskSignature
} from './pipeline-canvas-draft-store'
import { buildPipelineTabFilePath } from './open-pipeline-tab'
import { watchPipelineFileChanges } from './pipeline-file-change-watcher'

export type RepoPipelineRef = { worktreeId: string; id: string }
export type RepoPipelineFiles = {
  yamlText: string
  layoutText: string | null
  layout: PipelineLayout | null
  signature: PipelineDiskSignature
}
export type PersonalPipelineFiles = RepoPipelineFiles & { personalSignature: string }
export type PersonalPipelineWriteResult =
  | { status: 'written'; signature: string }
  | { status: 'conflict'; current: string | null }
export type PersonalPipelineDeleteResult =
  | { status: 'deleted' | 'not-found'; current: string | null }
  | { status: 'conflict'; current: string | null }

type PipelinePaths = {
  directory: string
  yamlRelativePath: string
  layoutRelativePath: string
  yamlPath: string
  layoutPath: string
}

function hashText(text: string): string {
  return [...sha256(new TextEncoder().encode(text))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function pipelinePaths(worktreePath: string, id: string): PipelinePaths {
  const parsedId = NodeIdSchema.parse(id)
  const directoryRelativePath = normalizeRelativePath('.orca/pipelines')
  const yamlRelativePath = normalizeRelativePath(`${directoryRelativePath}/${parsedId}.yaml`)
  const layoutRelativePath = normalizeRelativePath(
    `${directoryRelativePath}/${parsedId}.layout.json`
  )
  const directory = joinPath(worktreePath, directoryRelativePath)
  return {
    directory,
    yamlRelativePath,
    layoutRelativePath,
    yamlPath: joinPath(worktreePath, yamlRelativePath),
    layoutPath: joinPath(worktreePath, layoutRelativePath)
  }
}

function operationContext(
  worktreeId: string,
  pipelineRef?: string
): {
  runtime: RuntimeFileOperationArgs
  read: Omit<RuntimeFileReadArgs, 'filePath' | 'relativePath'>
  runtimeEnvironmentId: string | null
  worktreePath: string | null
} {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(
    worktreeId,
    worktreeId === state.activeWorktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  )
  const file = state.openFiles.find(
    (candidate) =>
      candidate.pipeline?.worktreeId === worktreeId &&
      (pipelineRef === undefined || candidate.pipeline.ref === pipelineRef)
  )
  const runtimeEnvironmentId =
    file?.runtimeEnvironmentId ?? getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  const ownerFile = file ?? { worktreeId, runtimeEnvironmentId }
  const runtime = getEditorFileOperationContext(state, ownerFile, worktree?.path ?? null)
  return {
    runtime,
    read: {
      settings: runtime.settings,
      worktreeId: runtime.worktreeId,
      connectionId: runtime.connectionId,
      expectedExternalSshTargetId: file?.externalSshTargetId
    },
    runtimeEnvironmentId,
    worktreePath: runtime.worktreePath
  }
}

function signatureForFiles(
  yamlText: string,
  layoutText: string | null,
  yamlMtime: number,
  layoutMtime: number
): PipelineDiskSignature {
  return {
    mtime: Math.max(yamlMtime, layoutMtime),
    sha256: hashText(`${yamlText}\0${layoutText ?? ''}`)
  }
}

async function readTextFile(
  operation: RuntimeFileOperationArgs,
  context: Omit<RuntimeFileReadArgs, 'filePath' | 'relativePath'>,
  relativePath: string
): Promise<{ text: string; mtime: number }> {
  const worktreePath = operation.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const filePath = joinPath(worktreePath, relativePath)
  const args: RuntimeFileReadArgs = { ...context, filePath, relativePath }
  const result = await readRuntimeFileContent(args)
  if (result.isBinary) {
    throw new Error('Pipeline files must contain UTF-8 text')
  }
  const stat = await statRuntimePath(operation, filePath)
  return { text: result.content, mtime: stat.mtime }
}

export async function readRepoPipeline({
  worktreeId,
  id
}: RepoPipelineRef): Promise<RepoPipelineFiles | null> {
  const { runtime, read } = operationContext(worktreeId, id)
  const worktreePath = runtime.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const paths = pipelinePaths(worktreePath, id)
  let yaml: { text: string; mtime: number }
  try {
    yaml = await readTextFile(runtime, read, paths.yamlRelativePath)
  } catch (error) {
    if (isMissingRuntimePathError(error)) {
      return null
    }
    throw error
  }
  let layoutText: string | null = null
  let layoutMtime = 0
  try {
    const layout = await readTextFile(runtime, read, paths.layoutRelativePath)
    layoutText = layout.text
    layoutMtime = layout.mtime
  } catch (error) {
    if (!isMissingRuntimePathError(error)) {
      throw error
    }
  }
  let layout: PipelineLayout | null = null
  if (layoutText !== null) {
    try {
      const parsed = PipelineLayoutSchema.safeParse(JSON.parse(layoutText))
      layout = parsed.success ? parsed.data : null
    } catch {
      layout = null
    }
  }
  return {
    yamlText: yaml.text,
    layoutText,
    layout,
    signature: signatureForFiles(yaml.text, layoutText, yaml.mtime, layoutMtime)
  }
}
function personalPipelineRequest(): NonNullable<typeof window.api.heimdall.pipelinePersonal> {
  const request = window.api?.heimdall?.pipelinePersonal
  if (typeof request !== 'function') {
    throw new Error('Personal pipeline storage is unavailable in this client.')
  }
  return request
}

function personalSignatureParts(signature: string): { mtime: number; sha256: string } {
  const match = /^([0-9]+(?:\.[0-9]+)?):([a-f0-9]{64})$/u.exec(signature)
  if (!match) {
    throw new Error('Personal pipeline returned an invalid disk signature.')
  }
  const mtime = Number(match[1])
  const sha256 = match[2]
  if (!Number.isFinite(mtime) || !sha256) {
    throw new Error('Personal pipeline returned an invalid disk signature.')
  }
  return { mtime, sha256 }
}

export function personalPipelineDiskSignature(
  yamlText: string,
  layoutText: string | null,
  personalSignature: string
): PipelineDiskSignature {
  const parts = personalSignatureParts(personalSignature)
  if (hashText(yamlText) !== parts.sha256) {
    throw new Error('Personal pipeline bytes do not match their disk signature.')
  }
  return {
    mtime: parts.mtime,
    sha256: hashText(`${yamlText}\0${layoutText ?? ''}`),
    personalSignature
  }
}

function parseLayoutText(layoutText: string | null): PipelineLayout | null {
  if (layoutText === null) {
    return null
  }
  try {
    const parsed = PipelineLayoutSchema.safeParse(JSON.parse(layoutText))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Reads profile-local bytes through the client runtime, never through a workspace runtime. */
export async function readPersonalPipeline({
  id
}: {
  id: string
}): Promise<PersonalPipelineFiles | null> {
  const request = personalPipelineRequest()
  const current = await request({ op: 'stat', id: NodeIdSchema.parse(id) })
  if (!('signature' in current)) {
    throw new Error('Personal pipeline storage returned an invalid stat result.')
  }
  if (current.signature === null) {
    return null
  }
  const source = await request({ op: 'read', id: NodeIdSchema.parse(id) })
  if (!('yamlText' in source)) {
    throw new Error('Personal pipeline storage returned an invalid read result.')
  }
  const personalSignature = source.signature
  return {
    yamlText: source.yamlText,
    layoutText: source.layoutText,
    layout: parseLayoutText(source.layoutText),
    signature: personalPipelineDiskSignature(source.yamlText, source.layoutText, personalSignature),
    personalSignature
  }
}

export async function writePersonalPipeline({
  id,
  yamlText,
  layoutText,
  expectedSignature
}: {
  id: string
  yamlText: string
  layoutText: string | null
  expectedSignature?: string
}): Promise<PersonalPipelineWriteResult> {
  const result = await personalPipelineRequest()({
    op: 'write',
    id: NodeIdSchema.parse(id),
    yamlText,
    layoutText,
    ...(expectedSignature === undefined ? {} : { expectedSignature })
  })
  if ('status' in result && result.status === 'written') {
    return { status: 'written', signature: result.signature }
  }
  if ('status' in result && result.status === 'conflict') {
    return result
  }
  throw new Error('Personal pipeline storage returned an invalid write result.')
}

export async function listPersonalPipelines(): Promise<{ id: string; name: string }[]> {
  const result = await personalPipelineRequest()({ op: 'list' })
  if (!('pipelines' in result)) {
    throw new Error('Personal pipeline storage returned an invalid list result.')
  }
  return result.pipelines
}

export async function statPersonalPipeline(id: string): Promise<string | null> {
  const result = await personalPipelineRequest()({ op: 'stat', id: NodeIdSchema.parse(id) })
  if (!('signature' in result)) {
    throw new Error('Personal pipeline storage returned an invalid stat result.')
  }
  return result.signature
}

export async function deletePersonalPipeline(
  id: string,
  expectedSignature: string
): Promise<PersonalPipelineDeleteResult> {
  const result = await personalPipelineRequest()({
    op: 'delete',
    id: NodeIdSchema.parse(id),
    expectedSignature
  })
  if ('status' in result && (result.status === 'deleted' || result.status === 'not-found')) {
    return { status: result.status, current: result.current ?? null }
  }
  if ('status' in result && result.status === 'conflict') {
    return result
  }
  throw new Error('Personal pipeline storage returned an invalid delete result.')
}

export async function deleteRepoPipeline({ worktreeId, id }: RepoPipelineRef): Promise<void> {
  const { runtime } = operationContext(worktreeId, id)
  const worktreePath = runtime.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const paths = pipelinePaths(worktreePath, id)
  await deleteRuntimePath(runtime, paths.yamlPath)
  if (await runtimePathExists(runtime, paths.layoutPath)) {
    await deleteRuntimePath(runtime, paths.layoutPath)
  }
}

async function ensurePipelineDirectory(
  context: RuntimeFileOperationArgs,
  paths: PipelinePaths
): Promise<void> {
  if (await runtimePathExists(context, paths.directory)) {
    return
  }
  const worktreePath = context.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const orcaDirectory = joinPath(worktreePath, normalizeRelativePath('.orca'))
  if (!(await runtimePathExists(context, orcaDirectory))) {
    await createRuntimePath(context, orcaDirectory, 'directory')
  }
  if (!(await runtimePathExists(context, paths.directory))) {
    await createRuntimePath(context, paths.directory, 'directory')
  }
}

export async function writeRepoPipeline({
  worktreeId,
  id,
  yamlText,
  layoutText,
  ownerRef
}: RepoPipelineRef & {
  yamlText: string
  layoutText: string
  ownerRef?: string
}): Promise<PipelineDiskSignature> {
  const { runtime, runtimeEnvironmentId } = operationContext(worktreeId, ownerRef ?? id)
  const worktreePath = runtime.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const paths = pipelinePaths(worktreePath, id)
  const signature = signatureForFiles(yamlText, layoutText, 0, 0)
  usePipelineCanvasDraftStore
    .getState()
    .rememberSelfWrite(buildPipelineTabFilePath('repo', worktreeId, id), signature.sha256)
  await ensurePipelineDirectory(runtime, paths)
  recordSelfWrite(paths.yamlPath, yamlText, runtimeEnvironmentId, SELF_WRITE_REMOTE_TTL_MS)
  await writeRuntimeFile(runtime, paths.yamlPath, yamlText)
  recordSelfWrite(paths.layoutPath, layoutText, runtimeEnvironmentId, SELF_WRITE_REMOTE_TTL_MS)
  await writeRuntimeFile(runtime, paths.layoutPath, layoutText)
  const [yamlStat, layoutStat] = await Promise.all([
    statRuntimePath(runtime, paths.yamlPath),
    statRuntimePath(runtime, paths.layoutPath)
  ])
  return signatureForFiles(yamlText, layoutText, yamlStat.mtime, layoutStat.mtime)
}

export async function listRepoPipelineIds(
  worktreeId: string,
  ownerRef?: string
): Promise<string[]> {
  const { runtime } = operationContext(worktreeId, ownerRef)
  const worktreePath = runtime.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const directory = joinPath(worktreePath, normalizeRelativePath('.orca/pipelines'))
  if (!(await runtimePathExists(runtime, directory))) {
    return []
  }
  const entries = await readRuntimeDirectory(runtime, directory)
  return entries.flatMap((entry) => {
    if (entry.isDirectory || entry.isSymlink || !entry.name.endsWith('.yaml')) {
      return []
    }
    const id = entry.name.slice(0, -'.yaml'.length)
    return NodeIdSchema.safeParse(id).success ? [id] : []
  })
}

export function nextFreePipelineId(id: string, existingIds: readonly string[]): string {
  const existing = new Set(existingIds)
  if (!existing.has(id)) {
    return id
  }
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `-${suffix}`
    const candidate = `${id.slice(0, 63 - suffixText.length)}${suffixText}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
}

export function copyPipelineSource(text: string, newId: string, newName: string): string {
  const parsedId = NodeIdSchema.parse(newId)
  const edits: PipelineEdit[] = [
    { kind: 'set-top', key: 'id', value: parsedId },
    { kind: 'set-top', key: 'name', value: newName.slice(0, 120) }
  ]
  return applyPipelineEdits(text, edits).text
}

export function watchRepoPipeline(
  { worktreeId, id }: RepoPipelineRef,
  onChange: () => void
): () => void {
  const { runtime, read, runtimeEnvironmentId } = operationContext(worktreeId, id)
  const worktreePath = runtime.worktreePath
  if (!worktreePath) {
    throw new Error('Pipeline workspace path is unavailable')
  }
  const paths = pipelinePaths(worktreePath, id)
  const watchedPaths = new Map([
    [
      normalizeRuntimePathForComparison(paths.yamlPath),
      { filePath: paths.yamlPath, relativePath: paths.yamlRelativePath }
    ],
    [
      normalizeRuntimePathForComparison(paths.layoutPath),
      { filePath: paths.layoutPath, relativePath: paths.layoutRelativePath }
    ]
  ])
  return watchPipelineFileChanges(runtime, read, runtimeEnvironmentId, watchedPaths, onChange)
}
