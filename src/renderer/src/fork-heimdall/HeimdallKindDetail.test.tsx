// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { WatcherLedgerSchema } from '../../../shared/fork-heimdall/ledger-types'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { ObjectiveEnrollmentPayloadSchema } from '../../../shared/fork-heimdall-objective/contract-types'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import { fallbackPipelineRunView } from '../fork-heimdall-pipeline/pipeline-run-view-client'
import {
  PipelineRunViewSchema,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { HeimdallKindDetail } from './HeimdallKindDetail'
import { HeimdallConcurrencyControl } from './HeimdallConcurrencyControl'

vi.mock('../fork-heimdall-objective/ObjectiveDetailSection', () => ({
  ObjectiveDetailSection: () => <div data-testid="objective-detail-section">Objective details</div>
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function rowForKind(kind: string) {
  const base = buildWatcherFleetEntry(1, 10)
  const pipelinePayload = {
    schemaVersion: 1,
    pin: {
      ref: 'repo:demo',
      scope: 'repo',
      id: 'demo',
      contentHash: `sha256:${'1'.repeat(64)}`,
      documentVersion: 1
    },
    document: {
      version: 1,
      id: 'demo',
      name: 'Demo',
      nodes: [
        { id: 'build', type: 'agent', label: 'Pinned build', harness: 'codex', prompt: 'Build' }
      ]
    },
    sourceText:
      'version: 1\nid: demo\nname: Demo\nnodes:\n  - id: build\n    type: agent\n    label: Pinned build\n    harness: codex\n    prompt: Build\n',
    runInputs: { task: 'Implement the feature' },
    workspaceKind: 'git'
  }
  const enrollment = {
    ...base.entry.enrollment,
    kind,
    ...(kind === 'pipeline' ? { kindPayload: pipelinePayload } : {})
  }
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [{ ...base, entry: { ...base.entry, enrollment } }],
    generatedAtMs: 10
  })
  const row = snapshot.entries[0]
  if (!row) {
    throw new Error('The reader fixture has no watcher row')
  }
  return row
}

function installRunView(viewFor: (target: { watcherId: string }) => unknown): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        pipelineRunView: vi.fn((target: { watcherId: string }) => Promise.resolve(viewFor(target)))
      }
    }
  })
}
function agentView(
  row: { target: { watcherId: string } },
  status: 'running' | 'failed'
): PipelineRunView {
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
        label: 'Build the feature',
        status,
        epoch: 0,
        attempt: 1,
        turns: 1
      }
    ],
    edges: [],
    asOfMs: 100
  })
}

describe('HeimdallKindDetail run graph', () => {
  it('mounts the same run graph for Objective, PR sitter, and custom Pipeline rows', async () => {
    const kinds = ['objective', 'hosted-review', 'pipeline']
    for (const kind of kinds) {
      const row = rowForKind(kind)
      installRunView(() => fallbackPipelineRunView(row))
      const rendered = render(
        <HeimdallKindDetail
          row={row}
          ledger={null}
          readOnly={false}
          busy={false}
          onAnswer={vi.fn().mockResolvedValue(null)}
        />
      )

      expect(await screen.findByTestId('pipeline-run-graph')).toBeInTheDocument()
      if (kind === 'objective') {
        expect(await screen.findByTestId('objective-detail-section')).toBeInTheDocument()
      }
      rendered.unmount()
    }
  })
  it('does not parse a Pipeline kind payload as Objective concurrency settings', () => {
    const objectivePayload = ObjectiveEnrollmentPayloadSchema.parse({
      objectiveText: 'Prepare a feature branch',
      tier: 'standard',
      landingBar: 'files-on-disk',
      lanesEnabled: true,
      maxConcurrency: 3,
      workspaceKind: 'git',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {}
    })
    const pipelineEnrollment = {
      ...rowForKind('pipeline').entry.enrollment,
      kindPayload: objectivePayload
    }
    const objectiveEnrollment = {
      ...rowForKind('objective').entry.enrollment,
      kindPayload: objectivePayload
    }
    const onChange = vi.fn()
    const props = {
      readOnly: false,
      busy: false,
      supported: true,
      updating: false,
      onChange
    }
    const rendered = render(
      <HeimdallConcurrencyControl enrollment={pipelineEnrollment} {...props} />
    )
    expect(screen.queryByLabelText('Max concurrency')).not.toBeInTheDocument()

    rendered.rerender(<HeimdallConcurrencyControl enrollment={objectiveEnrollment} {...props} />)
    expect(screen.getByLabelText('Max concurrency')).toHaveValue(3)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refreshes node state when the owner publishes a newer fleet observation', async () => {
    const row = rowForKind('pipeline')
    let request = 0
    installRunView(() => agentView(row, request++ === 0 ? 'running' : 'failed'))
    const onAnswer = vi.fn().mockResolvedValue(null)
    const rendered = render(
      <HeimdallKindDetail
        row={row}
        ledger={null}
        readOnly={false}
        busy={false}
        onAnswer={onAnswer}
      />
    )
    const statusId = 'pipeline-run-node-status-build'
    await waitFor(() =>
      expect(screen.getByTestId(statusId)).toHaveAttribute('data-tone', 'warning')
    )

    rendered.rerender(
      <HeimdallKindDetail
        row={{ ...row, observedAtMs: row.observedAtMs + 1 }}
        ledger={null}
        readOnly={false}
        busy={false}
        onAnswer={onAnswer}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId(statusId)).toHaveAttribute('data-tone', 'destructive')
    )
  })
  it('keeps an unknown watcher kind visible and refuses to open a pipeline choice', async () => {
    const row = rowForKind('future-watcher')
    const scope = {
      actionKind: 'pipeline-pass-gate',
      contentIdentity: 'pipeline:sha256:content',
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'approve',
        epoch: 0,
        attempt: 1,
        cause: 'gate'
      })
    }
    const unknownView = PipelineRunViewSchema.parse({
      watcherId: row.target.watcherId,
      kind: 'unknown',
      pin: {
        ref: 'unknown',
        scope: 'unknown',
        id: 'demo',
        contentHash: `sha256:${'0'.repeat(64)}`,
        documentVersion: 1,
        runNumber: null,
        label: 'Unknown watcher'
      },
      document: {
        version: 1,
        id: 'demo',
        name: 'Unknown watcher',
        inputs: {},
        nodes: [{ id: 'approve', type: 'gate', label: 'Approve changes' }]
      },
      nodes: [
        {
          instanceId: 'approve',
          nodeId: 'approve',
          type: 'gate',
          label: 'Approve changes',
          status: 'waiting',
          waitingFor: 'gate',
          epoch: 0,
          attempt: 1,
          turns: 0,
          escalationId: 'escalation-1'
        }
      ],
      edges: [],
      asOfMs: 10
    })
    installRunView(() => unknownView)
    const onAnswer = vi.fn().mockResolvedValue(null)
    render(
      <HeimdallKindDetail
        row={row}
        ledger={WatcherLedgerSchema.parse({
          watcherId: row.target.watcherId,
          entries: [
            {
              eventId: 'event-1',
              watcherId: row.target.watcherId,
              atMs: 10,
              origin: 'owner',
              class: 'fact',
              kind: 'escalation',
              escalationId: 'escalation-1',
              escalationKind: 'awaiting-approval',
              status: 'open',
              foldCount: 1,
              approvalScope: scope
            }
          ]
        })}
        readOnly={false}
        busy={false}
        onAnswer={onAnswer}
      />
    )

    expect(await screen.findByTestId('pipeline-run-graph')).toBeInTheDocument()
    expect(screen.queryByTestId('objective-detail-section')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('pipeline-run-node-approve'))
    expect(screen.queryByTestId('pipeline-gate-dialog')).not.toBeInTheDocument()
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
