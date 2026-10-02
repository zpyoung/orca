// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { fallbackPipelineRunView, loadPipelineRunView } from './pipeline-run-view-client'

const previousApi = window.api

afterEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
  vi.restoreAllMocks()
})

function installApi(heimdall: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { heimdall }
  })
}

describe('loadPipelineRunView', () => {
  it('uses an objective one-node fallback when an older host lacks the method', async () => {
    const base = buildWatcherFleetEntry(1, 10)
    const row = { ...base, workflowPhase: 'review' }
    installApi({})

    const view = await loadPipelineRunView(row)

    expect(view.kind).toBe('objective')
    expect(view.nodes).toHaveLength(1)
    expect(view.nodes[0]).toMatchObject({
      nodeId: 'objective',
      type: 'objective',
      phase: 'review',
      label: 'Objective v1'
    })
  })

  it('routes the run-view query through the selected local or remote watcher target', async () => {
    const base = buildWatcherFleetEntry(1, 10)
    const row = {
      ...base,
      target: { ...base.target, connectionId: 'remote-owner', pairingRevision: 7 }
    }
    const expected = fallbackPipelineRunView(row)
    const pipelineRunView = vi.fn().mockResolvedValue(expected)
    installApi({ pipelineRunView })

    await loadPipelineRunView(row)

    expect(pipelineRunView).toHaveBeenCalledWith(row.target)
  })

  it('falls back without relabeling an unknown future watcher as Objective', async () => {
    const base = buildWatcherFleetEntry(1, 10)
    const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
      entries: [
        {
          ...base,
          entry: {
            ...base.entry,
            enrollment: { ...base.entry.enrollment, kind: 'future-watcher' }
          }
        }
      ],
      generatedAtMs: 10
    })
    const row = snapshot.entries[0]
    if (!row) {
      throw new Error('The reader fixture has no watcher row')
    }
    installApi({})

    const view = await loadPipelineRunView(row)

    expect(view.kind).toBe('unknown')
    expect(view.pin.scope).toBe('unknown')
    expect(view.nodes).toMatchObject([{ type: 'unknown', label: row.entry.name }])
  })

  it('uses the same fleet-row fallback when the run-view method rejects', async () => {
    const row = buildWatcherFleetEntry(1, 10)
    installApi({ pipelineRunView: vi.fn().mockRejectedValue(new Error('method not found')) })

    await expect(loadPipelineRunView(row)).resolves.toMatchObject({
      watcherId: row.target.watcherId,
      kind: 'objective',
      nodes: [{ type: 'objective' }]
    })
  })
})
