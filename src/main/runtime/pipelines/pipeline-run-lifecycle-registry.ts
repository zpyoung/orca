/** Module-scope wiring shared by every pipeline-run-lifecycle entry point. */

import type { OrchestrationDb } from '../orchestration/db'
import { PipelineRunDb } from '../orchestration/pipeline-run-db'
import type { PipelineDriver } from './pipeline-driver'
import { PipelineSnapshotPublisher } from './pipeline-snapshot-publisher'

// per-run, never a singleton: unlike the module-scope activeCoordinator, many pipeline runs (and a
// pipeline run alongside an active coordinator run) must all proceed concurrently
const driversByRunId = new Map<string, PipelineDriver>()
const publishersByDb = new WeakMap<OrchestrationDb, PipelineSnapshotPublisher>()
const sweptDbs = new WeakSet<OrchestrationDb>()

export function registerPipelineDriver(runId: string, driver: PipelineDriver): void {
  driversByRunId.set(runId, driver)
}

export function getPipelineDriver(runId: string): PipelineDriver | undefined {
  return driversByRunId.get(runId)
}

export function getPipelineSnapshotPublisher(db: OrchestrationDb): PipelineSnapshotPublisher {
  let publisher = publishersByDb.get(db)
  if (!publisher) {
    publisher = new PipelineSnapshotPublisher(new PipelineRunDb(db))
    publishersByDb.set(db, publisher)
  }
  return publisher
}

// runs once per db, before any subscription is served, so a run whose driver died with a prior
// process reads as terminally interrupted instead of appearing live forever
export function ensurePipelineOrphanSweep(db: OrchestrationDb, pipelineDb: PipelineRunDb): void {
  if (sweptDbs.has(db)) {
    return
  }
  sweptDbs.add(db)
  pipelineDb.markOrphanedRunsInterrupted()
}
