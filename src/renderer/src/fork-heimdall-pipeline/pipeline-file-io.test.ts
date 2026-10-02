// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { sha256 } from '../../../shared/sha256'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import {
  PipelineDocumentSchema,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  copyPipelineSource,
  listRepoPipelineIds,
  nextFreePipelineId,
  readPersonalPipeline,
  readRepoPipeline,
  writePersonalPipeline,
  writeRepoPipeline
} from './pipeline-file-io'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

type RuntimeEvent = { kind: 'directory' | 'write'; path: string }

const runtimeFs = vi.hoisted(() => {
  const events: RuntimeEvent[] = []
  return {
    directories: new Set<string>(),
    files: new Map<string, { text: string; mtime: number }>(),
    events,
    directoryEntries: new Map<
      string,
      { name: string; isDirectory: boolean; isSymlink: boolean }[]
    >(),
    nextMtime: 100
  }
})

vi.mock('@/runtime/runtime-file-client', () => {
  const missingPath = (): Error & { code: string } =>
    Object.assign(new Error('Runtime path is missing'), { code: 'ENOENT' })

  return {
    createRuntimePath: async (_context: unknown, path: string, kind: 'file' | 'directory') => {
      if (kind === 'directory') {
        runtimeFs.directories.add(path)
        runtimeFs.events.push({ kind, path })
      } else {
        runtimeFs.files.set(path, { text: '', mtime: runtimeFs.nextMtime++ })
      }
    },
    isMissingRuntimePathError: (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT',
    readRuntimeDirectory: async (_context: unknown, path: string) =>
      runtimeFs.directoryEntries.get(path) ?? [],
    readRuntimeFileContent: async ({ filePath }: { filePath: string }) => {
      const file = runtimeFs.files.get(filePath)
      if (!file) {
        throw missingPath()
      }
      return { content: file.text, isBinary: false }
    },
    runtimePathExists: async (_context: unknown, path: string) =>
      runtimeFs.directories.has(path) || runtimeFs.files.has(path),
    statRuntimePath: async (_context: unknown, path: string) => {
      const file = runtimeFs.files.get(path)
      if (!file) {
        throw missingPath()
      }
      return { mtime: file.mtime }
    },
    subscribeRuntimeFileChanges: () => () => undefined,
    writeRuntimeFile: async (_context: unknown, path: string, content: string) => {
      runtimeFs.files.set(path, { text: content, mtime: runtimeFs.nextMtime++ })
      runtimeFs.events.push({ kind: 'write', path })
    }
  }
})

const worktreeId = 'repo-a::/repo-a'
const worktreePath = '/repo-a'
const pipelineDirectory = `${worktreePath}/.orca/pipelines`
const yamlPath = `${pipelineDirectory}/bugfix.yaml`
const layoutPath = `${pipelineDirectory}/bugfix.layout.json`

function seedWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const repo: Repo = {
    id: 'repo-a',
    path: worktreePath,
    displayName: 'Pipeline repository',
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
  const worktree: Worktree = {
    id: worktreeId,
    repoId: repo.id,
    path: worktreePath,
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Pipeline repository',
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
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] }
  })
}

function sampleDocument(): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix the issue' }]
  }
}

function personalSignature(yamlText: string, mtime: number): string {
  const digest = [...sha256(new TextEncoder().encode(yamlText))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${mtime}:${digest}`
}

beforeEach(() => {
  runtimeFs.directories.clear()
  runtimeFs.files.clear()
  runtimeFs.events.length = 0
  runtimeFs.directoryEntries.clear()
  runtimeFs.nextMtime = 100
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  seedWorkspace()
})

afterEach(() => {
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  useAppStore.setState(useAppStore.getInitialState(), true)
  __clearSelfWriteRegistryForTests()
})

describe('repository pipeline file I/O', () => {
  it('creates the repository pipeline directory, writes YAML before layout, and reads both with a stable signature', async () => {
    const document = sampleDocument()
    const layout = {
      version: 1 as const,
      nodes: { fix: { x: 48, y: 96 } },
      viewport: { x: 12, y: 24, zoom: 1.25 }
    }
    const signature = await writeRepoPipeline({
      worktreeId,
      id: document.id,
      yamlText: renderNewPipeline(document),
      layoutText: JSON.stringify(layout)
    })

    expect([...runtimeFs.directories]).toEqual([`${worktreePath}/.orca`, pipelineDirectory])
    expect(runtimeFs.events).toEqual([
      { kind: 'directory', path: `${worktreePath}/.orca` },
      { kind: 'directory', path: pipelineDirectory },
      { kind: 'write', path: yamlPath },
      { kind: 'write', path: layoutPath }
    ])

    const readback = await readRepoPipeline({ worktreeId, id: document.id })
    expect(parsePipelineText(readback?.yamlText ?? '').document).toMatchObject({
      id: 'bugfix',
      name: 'Bugfix',
      nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix the issue' }]
    })
    expect(readback?.layout).toEqual(layout)
    expect(readback?.signature).toEqual(signature)
  })

  it('keeps valid pipeline content readable when layout data is absent or unusable', async () => {
    expect(await readRepoPipeline({ worktreeId, id: 'bugfix' })).toBeNull()
    runtimeFs.directories.add(pipelineDirectory)
    runtimeFs.files.set(yamlPath, { text: renderNewPipeline(sampleDocument()), mtime: 20 })

    const withoutLayout = await readRepoPipeline({ worktreeId, id: 'bugfix' })
    expect(parsePipelineText(withoutLayout?.yamlText ?? '').document?.name).toBe('Bugfix')
    expect(withoutLayout?.layout).toBeNull()

    let previousSignature = withoutLayout?.signature.sha256
    for (const invalidLayout of ['not JSON', JSON.stringify({ version: 2, nodes: {} })]) {
      runtimeFs.files.set(layoutPath, { text: invalidLayout, mtime: 21 })
      const withInvalidLayout = await readRepoPipeline({ worktreeId, id: 'bugfix' })
      expect(parsePipelineText(withInvalidLayout?.yamlText ?? '').document?.id).toBe('bugfix')
      expect(withInvalidLayout?.layout).toBeNull()
      expect(withInvalidLayout?.signature.sha256).not.toBe(previousSignature)
      previousSignature = withInvalidLayout?.signature.sha256
    }
  })

  it('keeps valid repository IDs in runtime directory order while excluding non-pipeline entries', async () => {
    expect(await listRepoPipelineIds(worktreeId)).toEqual([])
    runtimeFs.directories.add(pipelineDirectory)
    runtimeFs.directoryEntries.set(pipelineDirectory, [
      { name: 'z-last.yaml', isDirectory: false, isSymlink: false },
      { name: 'alpha.yaml', isDirectory: false, isSymlink: false },
      { name: 'nested.yaml', isDirectory: true, isSymlink: false },
      { name: 'linked.yaml', isDirectory: false, isSymlink: true },
      { name: 'bad_id.yaml', isDirectory: false, isSymlink: false },
      { name: 'notes.YAML', isDirectory: false, isSymlink: false }
    ])

    expect(await listRepoPipelineIds(worktreeId)).toEqual(['z-last', 'alpha'])
  })

  it('changes only pipeline identity and name when copying YAML', () => {
    const source: PipelineDocument = {
      version: 1,
      id: 'bugfix',
      name: 'Bugfix',
      description: 'Repair and verify a reported issue.',
      inputs: { task: { type: 'text', required: true } },
      capabilities: { filesystem: 'on', github: 'gated' },
      defaults: { harness: 'codex', retry: 2, timeLimitMinutes: 45 },
      nodes: [{ id: 'fix', type: 'agent', harness: 'codex', prompt: 'Fix the issue', retry: 1 }]
    }
    const sourceYaml = renderNewPipeline(source)
    const copiedYaml = copyPipelineSource(sourceYaml, 'bugfix-copy', 'Bugfix copy')
    const original = PipelineDocumentSchema.parse(parsePipelineText(sourceYaml).document)
    const copied = PipelineDocumentSchema.parse(parsePipelineText(copiedYaml).document)
    const { id: originalId, name: originalName, ...originalContent } = original
    const { id, name, ...copiedContent } = copied

    expect({ id, name }).toEqual({ id: 'bugfix-copy', name: 'Bugfix copy' })
    expect({ id: originalId, name: originalName }).toEqual({ id: 'bugfix', name: 'Bugfix' })
    expect(copiedContent).toEqual(originalContent)
  })

  it('chooses the first unused numeric copy suffix and keeps a suffix within the ID length limit', () => {
    expect(nextFreePipelineId('repair', ['repair-2'])).toBe('repair')
    expect(nextFreePipelineId('repair', ['repair', 'repair-2', 'repair-3', 'repair-10'])).toBe(
      'repair-4'
    )

    const longestId = 'a'.repeat(63)
    const suffixedId = nextFreePipelineId(longestId, [longestId])
    expect(suffixedId).toBe(`${'a'.repeat(61)}-2`)
    expect(suffixedId).toHaveLength(63)
  })
})
describe('personal pipeline file I/O', () => {
  it('reads profile bytes and reports an optimistic-write conflict without replacing them', async () => {
    const initialYaml = renderNewPipeline(sampleDocument())
    const layoutText = JSON.stringify({ version: 1, nodes: { fix: { x: 48, y: 96 } } })
    const initialSignature = personalSignature(initialYaml, 10)
    const externalYaml = renderNewPipeline({ ...sampleDocument(), name: 'External change' })
    const changedSignature = personalSignature(externalYaml, 11)
    let storedYaml = initialYaml
    let storedLayout: string | null = layoutText
    let storedSignature = initialSignature
    const pipelinePersonal = vi.fn(
      async (request: {
        op: string
        id?: string
        yamlText?: string
        layoutText?: string | null
        expectedSignature?: string
      }) => {
        if (request.op === 'stat') {
          return { signature: storedSignature }
        }
        if (request.op === 'read') {
          return { yamlText: storedYaml, layoutText: storedLayout, signature: storedSignature }
        }
        if (request.op === 'write') {
          if (
            request.expectedSignature !== undefined &&
            request.expectedSignature !== storedSignature
          ) {
            return { status: 'conflict', current: storedSignature }
          }
          storedYaml = request.yamlText ?? ''
          storedLayout = request.layoutText ?? null
          storedSignature = personalSignature(storedYaml, 11)
          return { status: 'written', signature: storedSignature }
        }
        throw new Error(`Unexpected personal pipeline operation: ${request.op}`)
      }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { heimdall: { pipelinePersonal } }
    })

    const source = await readPersonalPipeline({ id: 'bugfix' })
    expect(source).toMatchObject({
      yamlText: initialYaml,
      layoutText,
      personalSignature: initialSignature,
      signature: { mtime: 10 }
    })

    storedYaml = externalYaml
    storedSignature = changedSignature
    const conflict = await writePersonalPipeline({
      id: 'bugfix',
      yamlText: renderNewPipeline({ ...sampleDocument(), name: 'Stale edit' }),
      layoutText: null,
      expectedSignature: source?.personalSignature
    })

    expect(conflict).toEqual({ status: 'conflict', current: changedSignature })
    expect(storedYaml).toBe(externalYaml)
    expect(storedLayout).toBe(layoutText)
    expect(runtimeFs.events).toEqual([])
  })
})
