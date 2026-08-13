import type Database from '../../sqlite/sync-database'
import type { ResolvedPipelineDefinition, ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import type { OrchestrationDb } from './db'

export type InstantiatePipelineRunArgs = {
  definition: ResolvedPipelineDefinition
  workspaceId: string | null
  workspaceDisplayName: string
  baseCommit: string | null
}

export type InstantiatePipelineRunResult = {
  runId: string
  runNumber: number
  taskIdByNodeId: Record<string, string>
}

type VisitState = 'visiting' | 'done'

/** Explicit-stack post-order DFS (same shape as `pipeline-template-graph-rules.ts`'s cycle check) so an arbitrarily long `needs` chain cannot overflow the call stack. */
function topologicalNodeOrder(nodes: ResolvedPipelineNode[]): ResolvedPipelineNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const state = new Map<string, VisitState>()
  const ordered: ResolvedPipelineNode[] = []

  for (const startNode of nodes) {
    if (state.has(startNode.id)) {
      continue
    }

    const stack: { node: ResolvedPipelineNode; needsIndex: number }[] = [
      { node: startNode, needsIndex: 0 }
    ]
    state.set(startNode.id, 'visiting')

    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (!frame) {
        break
      }
      if (frame.needsIndex >= frame.node.needs.length) {
        state.set(frame.node.id, 'done')
        ordered.push(frame.node)
        stack.pop()
        continue
      }

      const depId = frame.node.needs[frame.needsIndex]
      frame.needsIndex += 1

      const depState = state.get(depId)
      if (depState === 'visiting') {
        throw new Error(`Pipeline node cycle detected at "${depId}"`)
      }
      if (depState === 'done') {
        continue
      }
      const dependency = byId.get(depId)
      if (!dependency) {
        throw new Error(`Pipeline node "${frame.node.id}" depends on unknown node "${depId}"`)
      }
      state.set(dependency.id, 'visiting')
      stack.push({ node: dependency, needsIndex: 0 })
    }
  }
  return ordered
}

function allocateRunNumber(db: Database.Database, templateName: string): number {
  const counter = db
    .prepare('SELECT last_number FROM pipeline_run_counters WHERE template_name = ?')
    .get(templateName) as { last_number: number } | undefined
  const runNumber = (counter?.last_number ?? 0) + 1
  if (counter) {
    db.prepare('UPDATE pipeline_run_counters SET last_number = ? WHERE template_name = ?').run(
      runNumber,
      templateName
    )
  } else {
    db.prepare('INSERT INTO pipeline_run_counters (template_name, last_number) VALUES (?, ?)').run(
      templateName,
      runNumber
    )
  }
  return runNumber
}

/**
 * The L4 transaction: one connection-level `BEGIN IMMEDIATE … COMMIT` covering the detached run
 * row, one opaque task per node (fence F1 — no harness/model/effort/limits ever reaches a task
 * row, all four creator-authority fields stay unset), the pipeline snapshot, and run-number
 * allocation. All rows commit together or none do; not idempotent, every call is a new run.
 */
export function instantiatePipelineRun(
  db: Database.Database,
  orchestrationDb: OrchestrationDb,
  args: InstantiatePipelineRunArgs
): InstantiatePipelineRunResult {
  const { definition } = args
  const orderedNodes = topologicalNodeOrder(definition.nodes)

  db.exec('BEGIN IMMEDIATE')
  try {
    const run = orchestrationDb.createDetachedRun({ objective: definition.templateName })

    const taskIdByNodeId: Record<string, string> = {}
    for (const node of orderedNodes) {
      const task = orchestrationDb.createTask({
        spec: node.prompt,
        taskTitle: node.title,
        deps: node.needs.map((depId) => taskIdByNodeId[depId]),
        runId: run.id
      })
      taskIdByNodeId[node.id] = task.id
    }

    const runNumber = allocateRunNumber(db, definition.templateName)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO pipeline_runs (
         run_id, template_name, template_version, run_number, needs_newer_orca, state,
         input_text, snapshot_json, workspace_id, workspace_display_name, base_commit,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'setup', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      definition.templateName,
      definition.templateVersion,
      runNumber,
      definition.needsNewerOrca ? 1 : 0,
      definition.inputText,
      JSON.stringify(definition),
      args.workspaceId,
      args.workspaceDisplayName,
      args.baseCommit,
      now,
      now
    )

    const insertNode = db.prepare(
      `INSERT INTO pipeline_nodes (
         run_id, node_id, node_index, task_id, title, retries_allowed, prelaunch_failures
       ) VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    for (const node of definition.nodes) {
      insertNode.run(
        run.id,
        node.id,
        node.index,
        taskIdByNodeId[node.id],
        node.title,
        node.onFailure?.retries ?? 0
      )
    }

    db.exec('COMMIT')
    return { runId: run.id, runNumber, taskIdByNodeId }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
