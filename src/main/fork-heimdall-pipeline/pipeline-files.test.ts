import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DirEntry } from '../../shared/filesystem-entry-types'
import type { IFilesystemProvider } from '../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import type { ResolvedRuntimeFileTarget } from '../runtime/runtime-file-command-target'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import { listPipelineFiles, personalPipelineOperation, resolvePipelineFile } from './pipeline-files'
import { ensurePipelineTrackedForWorkspace } from './pipeline-rpc-methods'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'

const VALID_YAML = `version: 1
id: bugfix
name: Bugfix
nodes:
  - id: check
    type: check
    command: echo ok
`
const BROKEN_YAML = `version: 1
id: broken
name: Broken
nodes: []
`

function resolvedTarget(
  path: string,
  executionHostId: 'local' | `ssh:${string}`,
  worktreeId = 'worktree:repo-1::/workspace/repo'
): ResolvedRuntimeFileTarget {
  const git = {
    path,
    head: 'head-1',
    branch: 'main',
    isBare: false,
    isMainWorktree: true
  }
  return {
    executionHostId,
    worktree: {
      id: worktreeId,
      repoId: 'repo-1',
      path,
      head: git.head,
      branch: git.branch,
      isBare: git.isBare,
      isMainWorktree: git.isMainWorktree,
      git,
      displayName: 'Repository',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }
}

function localRuntime(target: ResolvedRuntimeFileTarget) {
  return { resolveRuntimeFileTarget: async (_selector: string) => target }
}

function profileStore(profileDirectory: string) {
  return {
    getProfileStorageDirectory: () => profileDirectory,
    getRepo: () => undefined
  }
}

function filesystemProvider(
  readDirectory: (path: string) => Promise<DirEntry[]>,
  readText: (path: string) => Promise<string>
): IFilesystemProvider {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected filesystem operation')
  }
  return {
    readDir: readDirectory,
    readFile: async (path) => ({ content: await readText(path), isBinary: false }),
    writeFile: unavailable,
    writeFileBase64: unavailable,
    writeFileBase64Chunk: unavailable,
    stat: unavailable,
    deletePath: unavailable,
    createFile: unavailable,
    createDir: unavailable,
    createDirNoClobber: unavailable,
    rename: unavailable,
    renameNoClobber: unavailable,
    copy: unavailable,
    realpath: unavailable,
    search: unavailable,
    listFiles: unavailable,
    watch: unavailable
  }
}

let temporaryDirectories: string[] = []
afterEach(async () => {
  unregisterSshFilesystemProvider('pipeline-files-test')
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  )
  temporaryDirectories = []
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-pipeline-rpc-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('pipeline file operations', () => {
  it('lists valid and broken repository files, built-ins, user scope, and pinned live runs', async () => {
    const root = await temporaryDirectory()
    const profile = join(root, 'profile')
    const repoPipelines = join(root, '.orca', 'pipelines')
    const userPipelines = join(profile, 'pipelines')
    await mkdir(repoPipelines, { recursive: true })
    await mkdir(userPipelines, { recursive: true })
    await writeFile(join(repoPipelines, 'bugfix.yaml'), VALID_YAML)
    await writeFile(join(repoPipelines, 'broken.yaml'), BROKEN_YAML)
    await writeFile(join(userPipelines, 'bugfix.yaml'), VALID_YAML)
    const parsed = parsePipelineText(VALID_YAML)
    if (parsed.document === null) {
      throw new Error('Valid test pipeline failed to parse')
    }
    const pin: PipelinePin = {
      ref: 'bugfix',
      scope: 'repo',
      id: 'bugfix',
      contentHash: pipelineContentHash(parsed.document),
      documentVersion: 1
    }
    const pipelineStore = createInMemoryPipelineStore()
    pipelineStore.recordRunPin('watcher-1', pin, 100)
    const target = resolvedTarget(root, 'local')
    const common = {
      runtime: localRuntime(target),
      store: profileStore(profile),
      pipelineStore,
      workspace: { repoId: 'repo-1', worktreeId: target.worktree.id },
      liveWatcherIds: new Set(['watcher-1'])
    }
    const local = await listPipelineFiles({ ...common, includePersonal: true })
    const remoteHost = await listPipelineFiles({ ...common, includePersonal: false })
    const bugfix = local.pipelines.find((pipeline) => pipeline.ref === 'bugfix')
    const broken = local.pipelines.find((pipeline) => pipeline.ref === 'broken')

    expect(bugfix).toMatchObject({
      scope: 'repo',
      id: 'bugfix',
      name: 'Bugfix',
      valid: true,
      errorCount: 0,
      contentHash: pin.contentHash,
      liveRuns: [{ watcherId: 'watcher-1', runNumber: 1, contentHash: pin.contentHash }]
    })
    expect(broken).toMatchObject({ scope: 'repo', valid: false, errorCount: expect.any(Number) })
    expect(broken?.errorCount).toBeGreaterThan(0)
    expect(local.pipelines.filter((pipeline) => pipeline.scope === 'builtin')).toHaveLength(2)
    expect(local.pipelines.find((pipeline) => pipeline.ref === 'user:bugfix')?.scope).toBe('user')
    expect(remoteHost.pipelines.some((pipeline) => pipeline.ref === 'user:bugfix')).toBe(false)
  })

  it('resolves path refs with source, layout, document and content identity', async () => {
    const root = await temporaryDirectory()
    const profile = join(root, 'profile')
    const directory = join(root, '.orca', 'pipelines')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'bugfix.yaml'), VALID_YAML)
    await writeFile(join(directory, 'bugfix.layout.json'), '{"version":1,"nodes":{}}')
    const target = resolvedTarget(root, 'local')

    const result = await resolvePipelineFile({
      runtime: localRuntime(target),
      store: profileStore(profile),
      workspace: { repoId: 'repo-1', worktreeId: target.worktree.id },
      ref: '.orca/pipelines/bugfix.yaml',
      allowPersonal: true
    })

    expect(result).toMatchObject({
      ref: 'bugfix',
      scope: 'repo',
      id: 'bugfix',
      sourceText: VALID_YAML,
      layoutText: '{"version":1,"nodes":{}}',
      document: { name: 'Bugfix' }
    })
    expect(result.contentHash).toBeTruthy()
  })

  it('lists and reads repository pipelines through the SSH filesystem route', async () => {
    const seenPaths: string[] = []
    const provider = filesystemProvider(
      async (path) => {
        seenPaths.push(path)
        return [{ name: 'bugfix.yaml', isDirectory: false, isSymlink: false }]
      },
      async (path) => {
        seenPaths.push(path)
        return VALID_YAML
      }
    )
    registerSshFilesystemProvider('pipeline-files-test', provider)
    const target = resolvedTarget('/srv/work/repo', 'ssh:pipeline-files-test')
    const result = await listPipelineFiles({
      runtime: localRuntime(target),
      store: profileStore('/profile'),
      pipelineStore: { liveRunsForRef: () => [] },
      workspace: { repoId: 'repo-1', worktreeId: target.worktree.id },
      liveWatcherIds: new Set(),
      includePersonal: false
    })

    expect(result.pipelines.find((pipeline) => pipeline.ref === 'bugfix')?.name).toBe('Bugfix')
    expect(seenPaths).toContain('/srv/work/repo/.orca/pipelines')
    expect(seenPaths).toContain('/srv/work/repo/.orca/pipelines/bugfix.yaml')
  })

  it('uses mtime and content signatures for personal writes, stale conflicts and deletion', async () => {
    const root = await temporaryDirectory()
    const profile = join(root, 'profile')
    const store = profileStore(profile)
    const initial = await personalPipelineOperation(store, {
      op: 'write',
      id: 'bugfix',
      yamlText: VALID_YAML,
      layoutText: '{"version":1,"nodes":{}}'
    })
    if (!('status' in initial) || initial.status !== 'written') {
      throw new Error('Initial personal pipeline write did not succeed')
    }
    const stale = await personalPipelineOperation(store, {
      op: 'write',
      id: 'bugfix',
      yamlText: 'external overwrite',
      expectedSignature: 'stale'
    })
    expect(stale).toEqual({ status: 'conflict', current: initial.signature })
    const read = await personalPipelineOperation(store, { op: 'read', id: 'bugfix' })
    expect(read).toMatchObject({
      yamlText: VALID_YAML,
      layoutText: '{"version":1,"nodes":{}}',
      signature: initial.signature
    })
    await expect(
      personalPipelineOperation(store, {
        op: 'delete',
        id: 'bugfix',
        expectedSignature: 'stale'
      })
    ).resolves.toEqual({ status: 'conflict', current: initial.signature })
    await expect(
      personalPipelineOperation(store, {
        op: 'delete',
        id: 'bugfix',
        expectedSignature: initial.signature
      })
    ).resolves.toEqual({ status: 'deleted', current: null })
    await expect(readFile(join(profile, 'pipelines', 'bugfix.yaml'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('bypasses Git tracking for folder workspaces without editing their ignore file', async () => {
    const root = await temporaryDirectory()
    const ignorePath = join(root, '.gitignore')
    await writeFile(ignorePath, '.orca/\n')
    const target = resolvedTarget(root, 'local', 'folder:folder-1')
    const runtime = localRuntime(target)
    const result = await ensurePipelineTrackedForWorkspace({
      runtime,
      store: profileStore(join(root, 'profile')),
      request: {
        workspace: { repoId: 'repo-1', worktreeId: target.worktree.id },
        pipelineId: 'bugfix'
      }
    })

    expect(result).toEqual({ status: 'tracked' })
    expect(await readFile(ignorePath, 'utf8')).toBe('.orca/\n')
  })
})
