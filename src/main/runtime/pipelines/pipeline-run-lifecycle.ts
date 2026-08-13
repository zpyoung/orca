/** Per-run lifecycle entry points the pipeline RPC methods delegate to: start, pause, resume, abort, observe. */

import type { PipelineRunSnapshotWire } from '../../../shared/pipeline-run-snapshot'
import type { ResolvedPipelineDefinition } from '../../../shared/pipeline-template-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { PipelineRunDb, type PipelineRunRow } from '../orchestration/pipeline-run-db'
import {
  instantiatePipelineRun,
  type InstantiatePipelineRunOutcome
} from './pipeline-instantiation'
import { PipelineDriver } from './pipeline-driver'
import {
  ensurePipelineOrphanSweep,
  getPipelineDriver,
  getPipelineSnapshotPublisher,
  registerPipelineDriver
} from './pipeline-run-lifecycle-registry'

function preparePipelineRunDb(db: OrchestrationDb): PipelineRunDb {
  const pipelineDb = new PipelineRunDb(db)
  ensurePipelineOrphanSweep(db, pipelineDb)
  return pipelineDb
}

function requirePipelineRun(pipelineDb: PipelineRunDb, runId: string): PipelineRunRow {
  const run = pipelineDb.getPipelineRun(runId)
  if (!run) {
    throw new OrchestrationError('run_not_found', `Pipeline run ${runId} was not found.`)
  }
  return run
}

export async function startPipelineRun(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  worktreeSelector: string
  definition: ResolvedPipelineDefinition
}): Promise<InstantiatePipelineRunOutcome> {
  const pipelineDb = preparePipelineRunDb(args.db)
  const outcome = await instantiatePipelineRun({
    runtime: args.runtime,
    db: args.db,
    pipelineDb,
    worktreeSelector: args.worktreeSelector,
    definition: args.definition
  })
  if ('refused' in outcome) {
    return outcome
  }

  const driver = new PipelineDriver({
    runtime: args.runtime,
    db: args.db,
    pipelineDb,
    runId: outcome.runId,
    definition: args.definition,
    publisher: getPipelineSnapshotPublisher(args.db)
  })
  registerPipelineDriver(outcome.runId, driver)
  driver.start()
  return outcome
}

export function pausePipelineRun(runId: string, db: OrchestrationDb): { state: string } {
  const pipelineDb = preparePipelineRunDb(db)
  getPipelineDriver(runId)?.pause()
  return { state: requirePipelineRun(pipelineDb, runId).state }
}

export function resumePipelineRun(runId: string, db: OrchestrationDb): { state: string } {
  const pipelineDb = preparePipelineRunDb(db)
  getPipelineDriver(runId)?.resume()
  return { state: requirePipelineRun(pipelineDb, runId).state }
}

export async function abortPipelineRun(
  runId: string,
  db: OrchestrationDb
): Promise<{ state: string }> {
  const pipelineDb = preparePipelineRunDb(db)
  await getPipelineDriver(runId)?.abort()
  return { state: requirePipelineRun(pipelineDb, runId).state }
}

export function listPipelineRuns(
  db: OrchestrationDb,
  filter?: { workspaceId?: string }
): PipelineRunRow[] {
  return preparePipelineRunDb(db).listPipelineRuns(filter)
}

export function subscribeToPipelineRun(
  db: OrchestrationDb,
  runId: string,
  emit: (snapshot: PipelineRunSnapshotWire) => void
): () => void {
  const pipelineDb = preparePipelineRunDb(db)
  requirePipelineRun(pipelineDb, runId)
  return getPipelineSnapshotPublisher(db).subscribe(runId, emit)
}
