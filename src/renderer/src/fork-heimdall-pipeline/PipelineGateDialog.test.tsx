// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type { ApprovalScope } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import {
  PipelineRunViewSchema,
  type PipelineRunNodeView,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { PipelineGateDialog, type PipelineChoiceCommand } from './PipelineGateDialog'

afterEach(cleanup)

function row(): WatcherFleetEntryReader {
  return readerRow()
}

function readerRow(): WatcherFleetEntryReader {
  const base = buildWatcherFleetEntry(1, 10)
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [
      {
        ...base,
        entry: {
          ...base.entry,
          enrollment: { ...base.entry.enrollment, kind: 'pipeline' }
        }
      }
    ],
    generatedAtMs: 10
  })
  const result = snapshot.entries[0]
  if (!result) {
    throw new Error('The reader fixture has no watcher row')
  }
  return result
}

function gateView(): { view: PipelineRunView; node: PipelineRunNodeView; scope: ApprovalScope } {
  const scope = scopeForGate()
  const node: PipelineRunNodeView = {
    instanceId: 'approve',
    nodeId: 'approve',
    type: 'gate',
    label: 'Review patch',
    status: 'waiting',
    waitingFor: 'gate',
    epoch: 0,
    attempt: 1,
    turns: 0,
    escalationId: 'gate-escalation'
  }
  const view = PipelineRunViewSchema.parse({
    watcherId: 'watcher-1',
    kind: 'pipeline',
    pin: {
      ref: 'repo:demo',
      scope: 'repo',
      id: 'demo',
      contentHash: `sha256:${'1'.repeat(64)}`,
      documentVersion: 1,
      runNumber: 1,
      label: 'Demo v1'
    },
    document: {
      version: 1,
      id: 'demo',
      name: 'Demo',
      inputs: {},
      nodes: [
        { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' },
        { id: 'approve', type: 'gate', label: 'Review patch', sendBackTo: 'build' }
      ]
    },
    nodes: [node],
    edges: [{ from: 'build', to: 'approve' }],
    asOfMs: 100
  })
  return { view, node, scope }
}

function scopeForGate(): ApprovalScope {
  return {
    actionKind: 'pipeline-pass-gate',
    contentIdentity: 'pipeline:sha256:content',
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId: 'approve',
      epoch: 0,
      attempt: 1,
      cause: 'gate'
    })
  }
}

function timeLimitView(): {
  view: PipelineRunView
  node: PipelineRunNodeView
  scope: ApprovalScope
} {
  const scope = timeLimitScope()
  const node: PipelineRunNodeView = {
    instanceId: 'build',
    nodeId: 'build',
    type: 'agent',
    label: 'Build feature',
    status: 'waiting',
    waitingFor: 'choice',
    epoch: 0,
    attempt: 1,
    turns: 3
  }
  const view = PipelineRunViewSchema.parse({
    watcherId: 'watcher-1',
    kind: 'pipeline',
    pin: {
      ref: 'repo:demo',
      scope: 'repo',
      id: 'demo',
      contentHash: `sha256:${'2'.repeat(64)}`,
      documentVersion: 1,
      runNumber: 1,
      label: 'Demo v1'
    },
    document: {
      version: 1,
      id: 'demo',
      name: 'Demo',
      inputs: {},
      nodes: [{ id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' }]
    },
    nodes: [node],
    edges: [],
    asOfMs: 100
  })
  return { view, node, scope }
}

function timeLimitScope(): ApprovalScope {
  return {
    actionKind: 'pipeline-apply-choice',
    contentIdentity: 'pipeline:sha256:content',
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId: 'build',
      epoch: 0,
      attempt: 1,
      cause: 'time-limit',
      deadlineMs: 99
    })
  }
}

function renderDialog(input: {
  view: PipelineRunView
  node: PipelineRunNodeView
  scope: ApprovalScope
  onAnswer: (command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>
  surface?: 'heimdall-detail' | 'canvas-run'
}): void {
  render(
    <PipelineGateDialog
      open
      onOpenChange={vi.fn()}
      view={input.view}
      node={input.node}
      scope={input.scope}
      row={row()}
      readOnly={false}
      busy={false}
      surface={input.surface ?? 'heimdall-detail'}
      onAnswer={input.onAnswer}
    />
  )
}

describe('PipelineGateDialog', () => {
  it('requires a send-back comment and sends the exact choice through the requested surface', async () => {
    const { view, node, scope } = gateView()
    const onAnswer =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswer.mockResolvedValue({ status: 'applied', appliedAtMs: 100 })
    renderDialog({ view, node, scope, onAnswer })

    expect(screen.getByTestId('pipeline-choice-approve')).toBeEnabled()
    expect(screen.getByTestId('pipeline-choice-send-back')).toBeDisabled()
    expect(screen.getByTestId('pipeline-choice-abort')).toBeEnabled()

    fireEvent.change(screen.getByTestId('pipeline-gate-comment'), {
      target: { value: 'split step 6' }
    })
    fireEvent.click(screen.getByTestId('pipeline-choice-send-back'))

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({
        kind: 'answer-pipeline-choice',
        scope,
        choice: 'send-back',
        comment: 'split step 6',
        surface: 'heimdall-detail'
      })
    )
  })

  it('shows first-answer attribution after a refused already-resolved response', async () => {
    const { view, node, scope } = gateView()
    const onAnswer =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswer.mockResolvedValue({
      status: 'refused',
      reason: 'already-resolved',
      detail: 'The gate has already been resolved.',
      resolvedBy: {
        actor: { user: 'alice', host: 'laptop' },
        surface: 'cli',
        atMs: 1_000
      }
    })
    renderDialog({ view, node, scope, onAnswer })

    fireEvent.click(screen.getByTestId('pipeline-choice-approve'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Already answered by alice@laptop from cli at /u
    )
  })

  it('offers Extend, Retry, Skip, Abort and validates the requested extension minutes', async () => {
    const { view, node, scope } = timeLimitView()
    const onAnswer =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswer.mockResolvedValue({ status: 'applied', appliedAtMs: 100 })
    renderDialog({ view, node, scope, onAnswer, surface: 'canvas-run' })

    expect(screen.getByTestId('pipeline-choice-extend')).toBeDisabled()
    expect(screen.getByTestId('pipeline-choice-retry')).toBeEnabled()
    expect(screen.getByTestId('pipeline-choice-skip')).toBeEnabled()
    expect(screen.getByTestId('pipeline-choice-abort')).toBeEnabled()
    fireEvent.change(screen.getByTestId('pipeline-extend-minutes'), { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('pipeline-choice-extend'))

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({
        kind: 'answer-pipeline-choice',
        scope,
        choice: 'extend',
        extendMinutes: 15,
        surface: 'canvas-run'
      })
    )
  })
})
