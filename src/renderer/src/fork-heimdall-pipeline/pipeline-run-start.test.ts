// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { HEIMDALL_PIPELINE_RUNTIME_CAPABILITY } from '../../../shared/fork-heimdall-pipeline/capability'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import {
  PipelineDocumentSchema,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import {
  ObjectiveEnrollmentPayloadSchema,
  objectiveCapabilityModes
} from '../../../shared/fork-heimdall-objective/contract-types'
import { objectiveKindPayloadFromDocument } from '../../../shared/fork-heimdall-pipeline/enrollment-routing'
import type { ObjectiveEnrollmentSubmission } from '../fork-heimdall-objective/objective-enrollment-request'
import { setLocalRuntimeCapabilitiesForTests } from '../runtime/local-runtime-capabilities'
import { startPipelineRun } from './pipeline-run-start'

const runMocks = {
  enroll: vi.fn(),
  pipelinePersonal: vi.fn()
}

const gitWorkspace: ObjectiveWorkspaceOption = {
  key: 'repo-a::/repo-a',
  repoId: 'repo-a',
  repoPath: '/repo-a',
  worktreeId: 'repo-a::/repo-a',
  workspacePath: '/repo-a',
  branch: 'main',
  workspaceKind: 'git',
  label: 'repo-a · main',
  detail: '/repo-a',
  owner: undefined,
  ownerUnavailable: false,
  availableAgentIds: ['codex']
}

function objectiveSubmissionForDocument(
  document: PipelineDocument,
  objectiveText: string
): ObjectiveEnrollmentSubmission {
  return {
    input: {
      kind: 'objective',
      repoId: gitWorkspace.repoId,
      worktreeId: gitWorkspace.worktreeId,
      capabilities: objectiveCapabilityModes('files-on-disk'),
      budget,
      kindPayload: ObjectiveEnrollmentPayloadSchema.parse(
        objectiveKindPayloadFromDocument(document, {
          objectiveText,
          workspaceKind: 'git'
        })
      )
    },
    owner: undefined
  }
}

const budget = { wallClockActiveMs: 60_000, turns: 5 }

function pipelineDocument(id: string, name: string): PipelineDocument {
  return {
    version: 1,
    id,
    name,
    inputs: { task: { type: 'text', required: true, default: 'Repair the issue' } },
    defaults: { harness: 'codex' },
    nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix $run.inputs.task' }]
  }
}

function installClientApi(sourceText: string): void {
  const signature = `10:${'a'.repeat(64)}`
  runMocks.enroll.mockReset()
  runMocks.pipelinePersonal.mockReset().mockImplementation(async ({ op }: { op: string }) => {
    if (op === 'read') {
      return { yamlText: sourceText, layoutText: null, signature }
    }
    return { signature }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: runMocks.enroll,
        onFleetChanged: () => () => undefined,
        pipelinePersonal: runMocks.pipelinePersonal
      }
    }
  })
}

function sourceStart(ref = 'user:bugfix', worktree = gitWorkspace) {
  return startPipelineRun({
    ref,
    worktree,
    grants: {},
    runInputs: { task: 'Repair the issue' },
    budget
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocalRuntimeCapabilitiesForTests([HEIMDALL_PIPELINE_RUNTIME_CAPABILITY])
})

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('startPipelineRun source contract', () => {
  it('rejects an invalid saved document by its scoped id without enrolling', async () => {
    const mismatchedFile = renderNewPipeline(pipelineDocument('other-pipeline', 'Other pipeline'))
    installClientApi(mismatchedFile)

    await expect(sourceStart()).rejects.toThrow(/id-mismatch/)

    expect(runMocks.pipelinePersonal).toHaveBeenCalledWith({ op: 'read', id: 'bugfix' })
    expect(runMocks.enroll).not.toHaveBeenCalled()
  })

  it('rejects run inputs with an undeclared key or a value of the wrong type before enrollment', async () => {
    const savedText = renderNewPipeline(pipelineDocument('bugfix', 'Bugfix'))
    const startWithInputs = (
      runInputs: Readonly<Record<string, string | number | boolean>>
    ): Promise<unknown> =>
      startPipelineRun({
        ref: 'user:bugfix',
        worktree: gitWorkspace,
        grants: {},
        runInputs,
        budget
      })

    installClientApi(savedText)
    await expect(startWithInputs({ task: 42 })).rejects.toThrow(/task/)
    expect(runMocks.enroll).not.toHaveBeenCalled()

    installClientApi(savedText)
    await expect(startWithInputs({ task: 'Repair the issue', extra: true })).rejects.toThrow(
      /extra/
    )
    expect(runMocks.enroll).not.toHaveBeenCalled()
  })

  it('refuses a folder workspace containing a Git-only node without enrolling', async () => {
    const folderPipeline = PipelineDocumentSchema.parse({
      version: 1,
      id: 'bugfix',
      name: 'Folder pipeline',
      inputs: {},
      nodes: [{ id: 'publish', type: 'land' }]
    })
    installClientApi(renderNewPipeline(folderPipeline))
    const folderWorkspace: ObjectiveWorkspaceOption = {
      ...gitWorkspace,
      key: 'folder-a',
      repoId: 'folder-a',
      repoPath: '/folder-a',
      worktreeId: null,
      workspacePath: '/folder-a',
      branch: null,
      workspaceKind: 'folder',
      label: 'folder-a'
    }

    await expect(sourceStart('user:bugfix', folderWorkspace)).rejects.toThrow(
      /git-only-node-in-folder/
    )

    expect(runMocks.enroll).not.toHaveBeenCalled()
  })

  it('refuses copied PR-sitter source on a known host without the pipeline runtime capability', async () => {
    const copiedSitter: PipelineDocument = {
      version: 1,
      id: 'bugfix-review',
      name: 'Copied review',
      inputs: {},
      nodes: [
        {
          id: 'review',
          type: 'pr-sitter',
          repeatFixLimit: 5,
          branchUpdateMode: 'rebase',
          mergeMethod: 'squash',
          mergeCheckScope: 'required'
        }
      ]
    }
    installClientApi(renderNewPipeline(copiedSitter))
    setLocalRuntimeCapabilitiesForTests([])

    await expect(sourceStart('user:bugfix-review')).rejects.toThrow(/Heimdall Pipeline v1/)

    expect(runMocks.enroll).not.toHaveBeenCalled()
  })

  it('enrolls the exact saved custom pipeline source rather than a changed draft', async () => {
    const savedDocument = pipelineDocument('bugfix', 'Saved Bugfix')
    const diskBytes = renderNewPipeline(savedDocument)
    const currentDraft = renderNewPipeline({ ...savedDocument, name: 'Unsaved Bugfix' })
    installClientApi(diskBytes)

    await sourceStart()

    expect(diskBytes).not.toBe(currentDraft)
    expect(runMocks.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pipeline',
        kindPayload: expect.objectContaining({
          pin: {
            ref: 'user:bugfix',
            scope: 'user',
            id: 'bugfix',
            contentHash: pipelineContentHash(savedDocument),
            documentVersion: 1
          },
          sourceText: diskBytes,
          document: expect.objectContaining({ name: 'Saved Bugfix' }),
          runInputs: { task: 'Repair the issue' }
        })
      }),
      undefined
    )
  })
  it('pins the exact personal PR-sitter source and preserves its native settings instead of a changed draft', async () => {
    const savedDocument: PipelineDocument = {
      version: 1,
      id: 'bugfix-review',
      name: 'Copied review',
      inputs: {},
      nodes: [
        {
          id: 'review',
          type: 'pr-sitter',
          repeatFixLimit: 5,
          branchUpdateMode: 'rebase',
          mergeMethod: 'squash',
          mergeCheckScope: 'required'
        }
      ]
    }
    const diskBytes = renderNewPipeline(savedDocument)
    const currentDraft = renderNewPipeline({ ...savedDocument, name: 'Unsaved review edit' })
    installClientApi(diskBytes)

    await sourceStart('user:bugfix-review')

    expect(diskBytes).not.toBe(currentDraft)
    expect(runMocks.enroll).toHaveBeenCalledTimes(1)
    expect(runMocks.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'hosted-review',
        pipelinePin: {
          ref: 'user:bugfix-review',
          scope: 'user',
          id: 'bugfix-review',
          contentHash: pipelineContentHash(savedDocument),
          documentVersion: 1
        },
        pipelineSource: { sourceText: diskBytes },
        kindPayload: {
          branchUpdateMode: 'rebase',
          mergeMethod: 'squash',
          mergeCheckScope: 'required',
          repeatFixLimit: 5
        }
      }),
      undefined
    )
  })

  it('pins copied Objective source beside the unchanged native payload settings', async () => {
    const savedDocument: PipelineDocument = {
      version: 1,
      id: 'objective-copy',
      name: 'Copied Objective',
      inputs: {},
      nodes: [
        {
          id: 'goal',
          type: 'objective',
          tier: 'standard',
          landingBar: 'files-on-disk',
          lanesEnabled: false,
          maxConcurrency: 2,
          roleAgents: { planner: 'codex' },
          checks: [{ name: 'verify', command: 'pnpm test', timeoutSeconds: 60 }]
        }
      ]
    }
    const diskBytes = renderNewPipeline(savedDocument)
    const objectiveText = 'Finish the release task from this copy.'
    installClientApi(diskBytes)

    await startPipelineRun({
      ref: 'user:objective-copy',
      worktree: gitWorkspace,
      grants: {},
      runInputs: {},
      budget,
      objectiveSubmission: objectiveSubmissionForDocument(savedDocument, objectiveText)
    })

    expect(runMocks.enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'objective',
        pipelinePin: {
          ref: 'user:objective-copy',
          scope: 'user',
          id: 'objective-copy',
          contentHash: pipelineContentHash(savedDocument),
          documentVersion: 1
        },
        pipelineSource: { sourceText: diskBytes },
        kindPayload: expect.objectContaining({
          objectiveText,
          tier: 'standard',
          landingBar: 'files-on-disk',
          lanesEnabled: false,
          maxConcurrency: 2,
          roleAgents: { planner: 'codex' },
          gates: [{ name: 'verify', command: 'pnpm test', timeoutSeconds: 60 }]
        })
      }),
      undefined
    )
  })
})
