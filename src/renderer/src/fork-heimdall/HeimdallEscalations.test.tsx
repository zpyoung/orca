// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import { WatcherLedgerSchema } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { PipelineChoiceCommand } from '../fork-heimdall-pipeline/PipelineGateDialog'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { HeimdallEscalations } from './HeimdallEscalations'

const previousApi = window.api

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
  vi.restoreAllMocks()
})

function rowForKind(kind: string): WatcherFleetEntryReader {
  const base = buildWatcherFleetEntry(1, 10)
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [
      { ...base, entry: { ...base.entry, enrollment: { ...base.entry.enrollment, kind } } }
    ],
    generatedAtMs: 10
  })
  const row = snapshot.entries[0]
  if (!row) {
    throw new Error('The reader fixture has no watcher row')
  }
  return row
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

function pipelineView(row: WatcherFleetEntryReader): PipelineRunView {
  return PipelineRunViewSchema.parse({
    watcherId: row.target.watcherId,
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
      nodes: [{ id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' }]
    },
    nodes: [
      {
        instanceId: 'build',
        nodeId: 'build',
        type: 'agent',
        label: 'Build feature',
        status: 'waiting',
        waitingFor: 'choice',
        epoch: 0,
        attempt: 1,
        turns: 3,
        escalationId: 'time-limit-escalation'
      }
    ],
    edges: [],
    asOfMs: 100
  })
}

function escalation(
  scope: ApprovalScope,
  watcherId: string,
  escalationId: string
): EscalationEntry {
  return {
    eventId: `event-${escalationId}`,
    watcherId,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId,
    escalationKind: 'awaiting-approval',
    status: 'open',
    foldCount: 1,
    approvalScope: scope
  }
}

function ledgerFor(entry: EscalationEntry): WatcherLedger {
  return WatcherLedgerSchema.parse({ watcherId: entry.watcherId, entries: [entry] })
}

function installRunViewApi(view: PipelineRunView) {
  const pipelineRunView = vi.fn().mockResolvedValue(view)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { heimdall: { pipelineRunView } }
  })
  return pipelineRunView
}

describe('HeimdallEscalations pipeline choices', () => {
  it('renders current time-limit options and sends a selected choice through the dialog', async () => {
    const row = rowForKind('pipeline')
    const scope = timeLimitScope()
    const entry = escalation(scope, row.target.watcherId, 'time-limit-escalation')
    const view = pipelineView(row)
    installRunViewApi(view)
    const onAnswerChoice =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswerChoice.mockResolvedValue({ status: 'applied', appliedAtMs: 50 })
    const onApprove = vi.fn()
    render(
      <HeimdallEscalations
        entries={[entry]}
        traces={[]}
        readOnly={false}
        busyKey={null}
        row={row}
        ledger={ledgerFor(entry)}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
      />
    )

    expect(await screen.findByTestId('heimdall-escalation-choice-extend')).toBeInTheDocument()
    expect(screen.getByTestId('heimdall-escalation-choice-retry')).toBeInTheDocument()
    expect(screen.getByTestId('heimdall-escalation-choice-skip')).toBeInTheDocument()
    expect(screen.getByTestId('heimdall-escalation-choice-abort')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('heimdall-escalation-choice-retry'))
    expect(await screen.findByTestId('pipeline-gate-dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('pipeline-choice-retry'))

    await waitFor(() =>
      expect(onAnswerChoice).toHaveBeenCalledWith({
        kind: 'answer-pipeline-choice',
        scope,
        choice: 'retry',
        surface: 'heimdall-detail'
      })
    )
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('preserves the ordinary approval button for a non-pipeline scope', () => {
    const row = rowForKind('objective')
    const scope: ApprovalScope = {
      actionKind: 'run-check',
      contentIdentity: 'objective-content',
      evidenceKey: 'check:unit'
    }
    const entry = escalation(scope, row.target.watcherId, 'objective-check')
    const onApprove = vi.fn()
    const onAnswerChoice =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswerChoice.mockResolvedValue(null)
    render(
      <HeimdallEscalations
        entries={[entry]}
        traces={[]}
        readOnly={false}
        busyKey={null}
        row={row}
        ledger={ledgerFor(entry)}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
      />
    )

    const approve = screen.getByRole('button', { name: /Approve:/u })
    expect(approve).toBeEnabled()
    expect(screen.queryByTestId('heimdall-escalation-choice-retry')).not.toBeInTheDocument()
    fireEvent.click(approve)
    expect(onApprove).toHaveBeenCalledWith('approve:objective-check', scope)
  })
  it('withholds pipeline choice controls for an unknown reader watcher kind', () => {
    const row = rowForKind('future-watcher')
    const scope = timeLimitScope()
    const entry = escalation(scope, row.target.watcherId, 'future-choice')
    const onApprove = vi.fn()
    const onAnswerChoice =
      vi.fn<(command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>>()
    onAnswerChoice.mockResolvedValue(null)
    render(
      <HeimdallEscalations
        entries={[entry]}
        traces={[]}
        readOnly
        busyKey={null}
        row={row}
        ledger={ledgerFor(entry)}
        onApprove={onApprove}
        onAnswerChoice={onAnswerChoice}
      />
    )

    expect(screen.queryByTestId('heimdall-escalation-choice-retry')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve:/u })).not.toBeInTheDocument()
  })
})
