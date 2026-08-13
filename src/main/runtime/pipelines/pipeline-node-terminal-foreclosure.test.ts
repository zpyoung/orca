/**
 * A pipeline node's dispatched terminal is never bound to its run (L14): PipelineRunDb.instantiate
 * creates a detached run (no pane), and nothing in the dispatch path binds one. `resolveRunScope` —
 * the same function `orchestration.taskCreate` calls — is what turns that absence into a
 * `run_required` refusal; `run-use` (`OrchestrationDb.bindRun`) is the escape hatch that proves this
 * is a default, not a sandbox.
 */
import { describe, expect, it } from 'vitest'
import type {
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { PipelineRunDb } from '../orchestration/pipeline-run-db'
import { resolveRunScope } from '../rpc/methods/orchestration-run-scope'

function node(overrides: Partial<ResolvedPipelineNode> & { id: string }): ResolvedPipelineNode {
  return {
    title: overrides.id,
    prompt: `prompt for ${overrides.id}`,
    index: 0,
    needs: [],
    harness: 'claude',
    ...overrides
  }
}

function definition(nodes: ResolvedPipelineNode[]): ResolvedPipelineDefinition {
  return {
    templateName: 'bugfix-fast',
    templateVersion: 1,
    needsNewerOrca: false,
    inputText: 'fix the flaky test',
    nodes
  }
}

function setup(): {
  db: OrchestrationDb
  runId: string
  runtime: OrcaRuntimeService
  nodePaneKey: string
} {
  const db = new OrchestrationDb(':memory:')
  const pipelineDb = new PipelineRunDb(db)
  const { runId } = pipelineDb.instantiate({
    definition: definition([node({ id: 'repro' })]),
    workspaceId: null,
    workspaceDisplayName: 'repo',
    baseCommit: null
  })
  const runtime = { getOrchestrationDb: () => db } as unknown as OrcaRuntimeService
  const nodePaneKey = 'tab_node:11111111-1111-4111-8111-111111111111'
  return { db, runId, runtime, nodePaneKey }
}

describe('pipeline node terminal foreclosure', () => {
  it('task-create fails from a pipeline node terminal: the driver never bound its pane to the run', () => {
    const { runtime, nodePaneKey } = setup()

    expect(() =>
      resolveRunScope(runtime, {
        callerTerminalHandle: 'term_node',
        callerPaneKey: nodePaneKey,
        requireCurrentConsumer: true
      })
    ).toThrow(expect.objectContaining({ code: 'run_required' }))
  })

  it('run-use then task-create succeeds: foreclosure is a default, not a sandbox', () => {
    const { db, runId, runtime, nodePaneKey } = setup()

    db.bindRun({ runId, coordinatorHandle: 'term_node', coordinatorPaneKey: nodePaneKey })

    const scoped = resolveRunScope(runtime, {
      callerTerminalHandle: 'term_node',
      callerPaneKey: nodePaneKey,
      requireCurrentConsumer: true
    })
    expect(scoped.id).toBe(runId)
  })
})
