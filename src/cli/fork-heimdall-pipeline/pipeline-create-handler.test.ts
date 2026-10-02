import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import {
  HEIMDALL_PIPELINE_NODE_CAPABILITY,
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall-pipeline/capability'
import {
  PIPELINE_NODE_TYPES,
  type NodeType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import type { HandlerContext } from '../dispatch'
import { HEIMDALL_CREATE_HANDLERS } from '../fork-heimdall/create-handler'

const callMock = vi.fn()
const SOURCE = `version: 1
id: bugfix
name: Bugfix
capabilities:
  agent: on
  push: on
  merge: on
inputs:
  priority:
    type: number
    required: true
nodes:
  - id: implement
    type: agent
    harness: claude
    prompt: Fix the requested task.
`
const INVALID_SOURCE = `version: 1
id: bugfix
name: Broken pipeline
nodes:
  - id: repro
    type: agent
    prompt: Reproduce the issue.
  - id: fix
    type: agent
    harness: claude
    prompt: Fix the issue.
    after: [ghost]
`
const OBJECTIVE_SOURCE = `version: 1
id: objective-copy
name: Objective copy
nodes:
  - id: objective
    type: objective
    tier: standard
    landingBar: files-on-disk
`

const SITTER_SOURCE = `version: 1
id: sitter
name: Sitter
nodes:
  - id: sitter
    type: pr-sitter
    mergeCheckScope: required
`
const DEFAULT_RUNTIME_CAPABILITIES = [
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITY,
  ...PIPELINE_NODE_TYPES.map(HEIMDALL_PIPELINE_NODE_CAPABILITY),
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
]
let previousExitCode: typeof process.exitCode

function response(result: unknown) {
  return { id: 'request-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
}
function sourceDocument(sourceText: string) {
  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw new Error('Expected a valid pipeline fixture')
  }
  return parsed.document
}

type ResolveFixture = {
  sourceText: string
  scope?: 'builtin' | 'repo' | 'user'
  id?: string
  ref?: string
  workspaceKind?: 'git' | 'folder'
  hostId?: string
  runtimeCapabilities?: string[]
}

function context(
  flags: [string, string | boolean][],
  fixture: ResolveFixture = { sourceText: SOURCE }
): HandlerContext {
  callMock.mockReset()
  const parsed = parsePipelineText(fixture.sourceText)
  const scope = fixture.scope ?? 'repo'
  const id = fixture.id ?? parsed.document?.id ?? 'broken'
  const ref = fixture.ref ?? (scope === 'repo' ? id : `${scope}:${id}`)
  const hash = parsed.document === null ? null : pipelineContentHash(parsed.document)
  const workspaceKind = fixture.workspaceKind ?? 'git'
  const runtimeCapabilities = fixture.runtimeCapabilities ?? DEFAULT_RUNTIME_CAPABILITIES
  const worktree = {
    id: workspaceKind === 'folder' ? 'folder:folder-1' : 'repo-1::/workspace',
    repoId: workspaceKind === 'folder' ? 'folder-repo' : 'repo-1',
    path: '/workspace',
    hostId: fixture.hostId ?? 'local'
  }
  callMock.mockImplementation(async (method: string) => {
    if (method === 'status.get') {
      return response({ capabilities: runtimeCapabilities, machineName: 'buildbox' })
    }
    if (method === 'worktree.show') {
      return response({ worktree })
    }
    if (method === 'repo.show') {
      return response({
        repo: {
          kind: workspaceKind === 'folder' ? 'folder' : 'git',
          executionHostId: 'local'
        }
      })
    }
    if (method === HEIMDALL_CHANNELS.pipelineResolve) {
      return response({
        ref,
        scope,
        id,
        sourceText: fixture.sourceText,
        layoutText: null,
        document: parsed.document,
        contentHash: hash,
        errors:
          parsed.document === null
            ? parsed.errors
            : validatePipeline(parsed.document, { workspaceKind, expectedId: id })
      })
    }
    if (method === HEIMDALL_CHANNELS.enroll) {
      return response({ status: 'enrolled', entry: { enrollment: { watcherId: 'watcher-1' } } })
    }
    if (method === HEIMDALL_CHANNELS.pipelineRunView) {
      if (parsed.document === null || hash === null) {
        throw new Error('Invalid source cannot have a run view')
      }
      return response({
        watcherId: 'watcher-1',
        kind: 'pipeline',
        pin: {
          ref,
          scope,
          id,
          contentHash: hash,
          documentVersion: 1,
          runNumber: 1,
          label: parsed.document.name
        },
        document: parsed.document,
        nodes: [],
        edges: [],
        asOfMs: 10
      })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  const mergedFlags: [string, string | boolean][] = [['worktree', 'path:/workspace'], ...flags]
  return {
    flags: new Map(mergedFlags),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler tests call only RuntimeClient.call and use a local runtime fake for workspace, pipeline and enrollment RPCs.
    client: { call: callMock, isRemote: false } as unknown as HandlerContext['client'],
    cwd: '/workspace',
    json: false
  }
}

function capabilityList(...nodeTypes: NodeType[]): string[] {
  return [
    HEIMDALL_PIPELINE_RUNTIME_CAPABILITY,
    ...nodeTypes.map((nodeType) => HEIMDALL_PIPELINE_NODE_CAPABILITY(nodeType))
  ]
}

beforeEach(() => {
  previousExitCode = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  callMock.mockReset()
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
})

describe('pipeline CLI creation', () => {
  it('advertises pipeline row compatibility from the native CLI', () => {
    expect(NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      HEIMDALL_PIPELINE_RUNTIME_CAPABILITY
    )
  })

  it('loads a file ref relative to the workspace and enrolls the pinned custom payload', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = context([
      ['pipeline', '/workspace/.orca/pipelines/bugfix.yaml'],
      ['spec', 'Fix the flaky login test'],
      ['input', 'priority=2'],
      ['cap', 'push=on']
    ])

    await HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)

    const methods = callMock.mock.calls.map(([method]) => method)
    expect(methods).toEqual([
      'status.get',
      'worktree.show',
      'repo.show',
      HEIMDALL_CHANNELS.pipelineResolve,
      HEIMDALL_CHANNELS.enroll,
      HEIMDALL_CHANNELS.pipelineRunView
    ])
    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.pipelineResolve, {
      workspace: { repoId: 'repo-1', worktreeId: 'repo-1::/workspace' },
      ref: '.orca/pipelines/bugfix.yaml'
    })
    const enrollment = callMock.mock.calls.find(
      ([method]) => method === HEIMDALL_CHANNELS.enroll
    )?.[1]
    expect(enrollment).toMatchObject({
      input: {
        kind: 'pipeline',
        capabilities: { agent: 'on', push: 'on', merge: 'gated' },
        kindPayload: {
          runInputs: { task: 'Fix the flaky login test', priority: 2 },
          sourceText: SOURCE,
          pin: {
            ref: 'bugfix',
            scope: 'repo',
            id: 'bugfix',
            contentHash: pipelineContentHash(sourceDocument(SOURCE)),
            documentVersion: 1
          }
        }
      },
      owner: null
    })
    expect(enrollment).not.toHaveProperty('input.pipelinePin')
    expect(enrollment).not.toHaveProperty('input.pipelineSource')
    expect(logSpy).toHaveBeenCalledWith(
      'Heimdall pipeline bugfix run #1 enrolled as watcher watcher-1.'
    )
  })

  it('rejects capability overrides outside user-grant keys before enrollment', async () => {
    const ctx = context([
      ['pipeline', 'bugfix'],
      ['spec', 'Fix the issue'],
      ['input', 'priority=2'],
      ['cap', 'gate=on']
    ])

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('unknown pipeline capability "gate"')
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })

  it('prints invalid-source errors by node id and never enrolls', async () => {
    const ctx = context(
      [
        ['pipeline', 'bugfix'],
        ['spec', 'Fix the issue']
      ],
      { sourceText: INVALID_SOURCE, id: 'bugfix' }
    )

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('repro missing-field:'),
      data: {
        errors: [
          { nodeId: 'repro', code: 'missing-field' },
          { nodeId: 'fix', code: 'dangling-edge' }
        ]
      }
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.pipelineRunView, expect.anything())
  })

  it('refuses a host missing the pipeline capability before workspace or resolve calls', async () => {
    const ctx = context(
      [
        ['pipeline', 'bugfix'],
        ['spec', 'Fix the issue']
      ],
      { sourceText: SOURCE, runtimeCapabilities: [] }
    )

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('does not support Heimdall pipelines')
    })
    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })

  it('refuses node types the host does not advertise before enrollment', async () => {
    const ctx = context(
      [
        ['pipeline', 'bugfix'],
        ['spec', 'Fix the issue']
      ],
      { sourceText: SOURCE, runtimeCapabilities: capabilityList() }
    )

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '- node-type-unsupported-by-host: Update Orca on buildbox to run this pipeline (needs: Agent)'
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })

  it('enrolls an ungated Objective source without requiring parallel-execution capability', async () => {
    const runtimeCapabilities = DEFAULT_RUNTIME_CAPABILITIES.filter(
      (capability) => capability !== HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    )
    const ctx = context(
      [
        ['pipeline', 'objective-copy'],
        ['spec', 'Ship the feature']
      ],
      { sourceText: OBJECTIVE_SOURCE, runtimeCapabilities }
    )

    await HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)

    const enrollment = callMock.mock.calls.find(
      ([method]) => method === HEIMDALL_CHANNELS.enroll
    )?.[1]
    expect(enrollment).toMatchObject({
      input: {
        kind: 'objective',
        kindPayload: {
          objectiveText: 'Ship the feature',
          tier: 'standard',
          landingBar: 'files-on-disk'
        }
      }
    })
  })

  it('builds hosted-review enrollment from a PR-sitter node', async () => {
    const ctx = context(
      [
        ['pipeline', 'sitter'],
        ['spec', 'Review the task']
      ],
      { sourceText: SITTER_SOURCE }
    )

    await HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)

    const enrollment = callMock.mock.calls.find(
      ([method]) => method === HEIMDALL_CHANNELS.enroll
    )?.[1]
    expect(enrollment).toMatchObject({
      input: {
        kind: 'hosted-review',
        kindPayload: {
          branchUpdateMode: 'merge-base-update',
          mergeMethod: null,
          mergeCheckScope: 'required'
        }
      }
    })
  })

  it('rejects a path outside the selected workspace and does not resolve it', async () => {
    const ctx = context([
      ['pipeline', '/outside/.orca/pipelines/bugfix.yaml'],
      ['spec', 'Fix the issue']
    ])

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('must be inside the selected worktree')
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.pipelineResolve, expect.anything())
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })

  it('retains the local-workspace guard without an SSH fallback', async () => {
    const ctx = context(
      [
        ['pipeline', 'bugfix'],
        ['spec', 'Fix the issue']
      ],
      { sourceText: SOURCE, hostId: 'ssh:builder' }
    )

    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('local execution host')
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.pipelineResolve, expect.anything())
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })
})
