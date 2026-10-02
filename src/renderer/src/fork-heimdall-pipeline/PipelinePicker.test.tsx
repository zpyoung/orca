// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { sha256 } from '../../../shared/sha256'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { builtinPipelinePin } from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type { PipelineValidationError } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { PipelinePicker, type LoadedPipelineSelection } from './PipelinePicker'

afterEach(() => cleanup())

const pickerMocks = { pipelineResolve: vi.fn() }

function personalSignature(yamlText: string, mtime = 10): string {
  const digest = [...sha256(new TextEncoder().encode(yamlText))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${mtime}:${digest}`
}

const workspace: ObjectiveWorkspaceOption = {
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

function document(id: string, name: string): PipelineDocument {
  return {
    version: 1,
    id,
    name,
    inputs: { task: { type: 'text', required: true, default: 'Fix the issue' } },
    defaults: { harness: 'codex' },
    nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix $run.inputs.task' }]
  }
}

function installPickerApi(
  resolvedRef = 'bugfix',
  resolvedErrors: readonly PipelineValidationError[] = []
): void {
  const repoDocument = document('bugfix', 'Repository bugfix')
  const personalDocument = document('bugfix', 'Personal bugfix')
  const repoSourceText = renderNewPipeline(repoDocument)
  const personalSourceText = renderNewPipeline(personalDocument)
  const objectiveContentHash = builtinPipelinePin('objective').contentHash
  const prSitterContentHash = builtinPipelinePin('pr-sitter').contentHash
  const signature = personalSignature(personalSourceText)
  pickerMocks.pipelineResolve.mockReset().mockImplementation(async () => ({
    ref: resolvedRef,
    scope: resolvedRef === 'user:bugfix' ? 'user' : 'repo',
    id: 'bugfix',
    sourceText: repoSourceText,
    layoutText: null,
    document: repoDocument,
    contentHash: pipelineContentHash(repoDocument),
    errors: resolvedErrors
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: vi.fn(),
        onFleetChanged: () => () => undefined,
        pipelineList: async () => ({
          pipelines: [
            {
              ref: 'builtin:objective',
              scope: 'builtin',
              id: 'objective',
              name: 'Objective',
              valid: true,
              errorCount: 0,
              contentHash: objectiveContentHash,
              liveRuns: []
            },
            {
              ref: 'builtin:pr-sitter',
              scope: 'builtin',
              id: 'pr-sitter',
              name: 'PR sitter',
              valid: true,
              errorCount: 0,
              contentHash: prSitterContentHash,
              liveRuns: []
            },
            {
              ref: 'bugfix',
              scope: 'repo',
              id: 'bugfix',
              name: repoDocument.name,
              valid: true,
              errorCount: 0,
              contentHash: pipelineContentHash(repoDocument),
              liveRuns: []
            }
          ]
        }),
        pipelineResolve: pickerMocks.pipelineResolve,
        pipelinePersonal: async ({ op }: { op: string }) => {
          if (op === 'list') {
            return { pipelines: [{ id: 'bugfix', name: personalDocument.name }] }
          }
          if (op === 'stat') {
            return { signature }
          }
          if (op === 'read') {
            return { yamlText: personalSourceText, layoutText: null, signature }
          }
          throw new Error(`Unexpected personal pipeline operation: ${op}`)
        }
      }
    }
  })
}

function renderPicker(
  onSelectionChange: (selection: LoadedPipelineSelection | null) => void
): void {
  render(
    <PipelinePicker
      workspace={workspace}
      worktreeId={workspace.worktreeId}
      onSelectionChange={onSelectionChange}
    />
  )
}

describe('PipelinePicker', () => {
  it('preselects Objective and keeps repository and personal copies with the same id distinct', async () => {
    const user = userEvent.setup()
    installPickerApi()
    const onSelectionChange = vi.fn<(selection: LoadedPipelineSelection | null) => void>()
    renderPicker(onSelectionChange)

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ref: 'builtin:objective', scope: 'builtin', id: 'objective' })
      )
    )
    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }))
    const bugfixOptions = (await screen.findAllByRole('option')).filter((option) =>
      option.textContent?.includes('bugfix')
    )
    expect(bugfixOptions).toHaveLength(2)
    const personalOption = bugfixOptions.find((option) => option.textContent?.includes('Personal'))
    if (!personalOption) {
      throw new Error('The personal Bugfix choice is missing.')
    }

    await user.click(personalOption)
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ref: 'user:bugfix',
          scope: 'user',
          id: 'bugfix',
          document: expect.objectContaining({ name: 'Personal bugfix' })
        })
      )
    )

    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }))
    const reopenedBugfixOptions = (await screen.findAllByRole('option')).filter((option) =>
      option.textContent?.includes('bugfix')
    )
    const repoOption = reopenedBugfixOptions.find(
      (option) => !option.textContent?.includes('Personal')
    )
    if (!repoOption) {
      throw new Error('The repository Bugfix choice is missing.')
    }
    await user.click(repoOption)
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ref: 'bugfix',
          scope: 'repo',
          id: 'bugfix',
          document: expect.objectContaining({ name: 'Repository bugfix' })
        })
      )
    )

    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }))
    await user.click(screen.getByRole('option', { name: /PR sitter.*Built-in/ }))
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ref: 'builtin:pr-sitter', scope: 'builtin', id: 'pr-sitter' })
      )
    )
  })

  it('clears the selected source when a repository ref resolves to another scope', async () => {
    const user = userEvent.setup()
    installPickerApi('user:bugfix')
    const onSelectionChange = vi.fn<(selection: LoadedPipelineSelection | null) => void>()
    renderPicker(onSelectionChange)

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ref: 'builtin:objective', scope: 'builtin' })
      )
    )
    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }))
    await user.click(screen.getByRole('option', { name: /Repository bugfix/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Repository pipeline bugfix resolved to a different source.'
    )
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith(null))
  })
  it('marks a selected pipeline invalid when its node type is unsupported by the host', async () => {
    const user = userEvent.setup()
    const hostError: PipelineValidationError = {
      nodeId: null,
      code: 'node-type-unsupported-by-host',
      message: 'Update Orca on old host to run this pipeline (needs: Agent)'
    }
    installPickerApi('bugfix', [hostError])
    const onSelectionChange = vi.fn<(selection: LoadedPipelineSelection | null) => void>()
    renderPicker(onSelectionChange)

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ref: 'builtin:objective', scope: 'builtin' })
      )
    )
    await user.click(screen.getByRole('combobox', { name: 'Pipeline' }))
    await user.click(screen.getByRole('option', { name: /Repository bugfix/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent(hostError.message)
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ ref: 'bugfix', scope: 'repo', valid: false, errorCount: 1 })
      )
    )
  })
})
