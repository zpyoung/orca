// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useAppStore } from '@/store'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import type { Repo } from '../../../shared/repo-types'
import { HEIMDALL_PIPELINE_RUNTIME_CAPABILITY } from '../../../shared/fork-heimdall-pipeline/capability'
import type { EnrollSuccessReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { sha256 } from '../../../shared/sha256'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { setLocalRuntimeCapabilitiesForTests } from '../runtime/local-runtime-capabilities'
import { PipelineRunForm } from './PipelineRunForm'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocalRuntimeCapabilitiesForTests(null)
})

const repo: Repo = {
  id: 'repo-a',
  path: '/repo-a',
  displayName: 'Pipeline repository',
  badgeColor: '',
  addedAt: 0,
  kind: 'git',
  executionHostId: 'local'
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
const enroll = vi.fn<HeimdallApi['enroll']>()
const enrollmentEntry = buildWatcherFleetEntry(1).entry
const successfulEnrollment = {
  status: 'enrolled',
  entry: {
    ...enrollmentEntry,
    name: 'Bugfix run',
    enrollment: { ...enrollmentEntry.enrollment, kind: 'pipeline' }
  }
} satisfies EnrollSuccessReader

function personalSignature(yamlText: string, mtime = 10): string {
  const digest = [...sha256(new TextEncoder().encode(yamlText))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${mtime}:${digest}`
}

function pipelineDocument(
  inputs: PipelineDocument['inputs'] = {
    task: { type: 'text', label: 'Task', required: true, default: 'Repair the release blocker' },
    attempts: { type: 'number', label: 'Attempts', required: true, default: 2 }
  }
): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs,
    capabilities: { push: 'on' },
    nodes: [
      {
        id: 'tests',
        type: 'script',
        command: 'pnpm test',
        capability: 'check',
        inputs: { TASK: '$run.inputs.task', ATTEMPTS: '$run.inputs.attempts' }
      },
      { id: 'land', type: 'land', after: ['tests'], draft: false }
    ]
  }
}

function installRunApi(sourceText: string): void {
  enroll.mockReset().mockResolvedValue(successfulEnrollment)
  const signature = personalSignature(sourceText)
  const pipelinePersonal: NonNullable<HeimdallApi['pipelinePersonal']> = async (request) => {
    if (request.op === 'stat') {
      return { signature }
    }
    if (request.op === 'read') {
      return { yamlText: sourceText, layoutText: null, signature }
    }
    throw new Error(`Unexpected personal pipeline operation: ${request.op}`)
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll,
        onFleetChanged: () => () => undefined,
        pipelinePersonal
      }
    }
  })
}

function renderRunForm(document: PipelineDocument): void {
  useAppStore.setState({ repos: [repo] })
  function RunForm() {
    const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState(workspace.key)
    return (
      <PipelineRunForm
        pipelineRef="user:bugfix"
        document={document}
        workspaces={[workspace]}
        selectedWorkspaceKey={selectedWorkspaceKey}
        onWorkspaceChange={setSelectedWorkspaceKey}
      />
    )
  }
  render(<RunForm />)
}

function submitRunForm(): void {
  fireEvent.submit(screen.getByRole('form', { name: 'Run pipeline' }))
}

describe('PipelineRunForm', () => {
  it('enrolls with a customized grant and valid inputs', async () => {
    const user = userEvent.setup()
    const document = pipelineDocument()
    installRunApi(renderNewPipeline(document))
    setLocalRuntimeCapabilitiesForTests([HEIMDALL_PIPELINE_RUNTIME_CAPABILITY])
    renderRunForm(document)

    const pushGrant = screen.getByRole('combobox', { name: 'Granted mode for Push' })
    const landGrant = screen.getByRole('combobox', { name: 'Granted mode for Land' })
    expect(
      within(pushGrant.parentElement!.parentElement!).getByText('Requested on')
    ).toBeInTheDocument()
    expect(pushGrant).toHaveTextContent('gated')
    expect(
      within(landGrant.parentElement!.parentElement!).getByText('Requested gated')
    ).toBeInTheDocument()
    expect(landGrant).toHaveTextContent('gated')

    await user.click(pushGrant)
    await user.click(screen.getByRole('option', { name: 'on' }))
    expect(pushGrant).toHaveTextContent('on')
    await user.click(landGrant)
    await user.click(screen.getByRole('option', { name: 'off' }))
    expect(landGrant).toHaveTextContent('off')
    const task = screen.getByRole('textbox', { name: /Task/ })
    fireEvent.change(task, { target: { value: 'Repair the release blocker' } })
    expect(task).toHaveValue('Repair the release blocker')
    submitRunForm()

    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pipeline',
        repoId: workspace.repoId,
        worktreeId: workspace.worktreeId,
        capabilities: { check: 'gated', push: 'on', land: 'off' },
        kindPayload: expect.objectContaining({
          runInputs: { task: 'Repair the release blocker', attempts: 2 }
        }),
        budget: { wallClockActiveMs: 4 * 60 * 60 * 1_000, turns: 40 }
      }),
      undefined
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps Start run disabled until required inputs and both budget boundaries are valid, then enrolls', async () => {
    const document = pipelineDocument({
      task: { type: 'text', label: 'Task', required: true },
      attempts: { type: 'number', label: 'Attempts', required: true }
    })
    installRunApi(renderNewPipeline(document))
    setLocalRuntimeCapabilitiesForTests([HEIMDALL_PIPELINE_RUNTIME_CAPABILITY])
    renderRunForm(document)

    const start = screen.getByRole('button', { name: 'Start run' })
    const task = screen.getByRole('textbox', { name: /Task/ })
    const attempts = screen.getByRole('spinbutton', { name: /Attempts/ })
    const hours = screen.getByRole('spinbutton', { name: 'Active-work budget (hours)' })
    const turns = screen.getByRole('spinbutton', { name: 'Turn budget' })
    expect(start).toBeDisabled()

    fireEvent.change(task, { target: { value: 'Fix the deployment' } })
    expect(start).toBeDisabled()
    fireEvent.change(attempts, { target: { value: '2' } })
    fireEvent.change(hours, { target: { value: '0' } })
    expect(hours).toHaveAttribute('aria-invalid', 'true')
    expect(start).toBeDisabled()

    fireEvent.change(hours, { target: { value: '1' } })
    fireEvent.change(turns, { target: { value: '1.5' } })
    expect(turns).toHaveAttribute('aria-invalid', 'true')
    expect(start).toBeDisabled()

    fireEvent.change(turns, { target: { value: '0' } })
    expect(start).toBeEnabled()
    submitRunForm()
    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pipeline',
        kindPayload: expect.objectContaining({
          runInputs: { task: 'Fix the deployment', attempts: 2 }
        }),
        budget: { wallClockActiveMs: 60 * 60 * 1_000, turns: 0 }
      }),
      undefined
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an enrollment error when a valid form submission is refused', async () => {
    const document = pipelineDocument()
    installRunApi(renderNewPipeline(document))
    enroll.mockReset().mockRejectedValue(new Error('Enrollment was refused.'))
    setLocalRuntimeCapabilitiesForTests([HEIMDALL_PIPELINE_RUNTIME_CAPABILITY])
    renderRunForm(document)

    submitRunForm()

    expect(await screen.findByRole('alert')).toHaveTextContent('Enrollment was refused.')
    expect(enroll).toHaveBeenCalledTimes(1)
  })
})
