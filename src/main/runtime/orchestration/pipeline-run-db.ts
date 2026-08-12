import type Database from '../../sqlite/sync-database'
import type { PipelineRunState } from '../../../shared/pipeline-run-snapshot'
import type { OrchestrationDb } from './db'
import {
  beginAttempt,
  endAttempt,
  incrementPrelaunchFailures,
  resetPrelaunchFailures,
  setNodeOutcome,
  type BeginAttemptArgs,
  type EndAttemptArgs
} from './pipeline-run-db-attempts'
import {
  instantiatePipelineRun,
  type InstantiatePipelineRunArgs,
  type InstantiatePipelineRunResult
} from './pipeline-run-db-instantiate'
import {
  getPipelineAttempts,
  getPipelineNodes,
  getPipelineRun,
  listPipelineRuns,
  markOrphanedRunsInterrupted,
  recordWorktreeSetup,
  updateRunState
} from './pipeline-run-db-queries'
import { ensurePipelineRunSchema } from './pipeline-run-db-schema'
import type { PipelineAttemptRow, PipelineNodeRow, PipelineRunRow } from './pipeline-run-db-types'

export type { PipelineAttemptRow, PipelineNodeRow, PipelineRunRow } from './pipeline-run-db-types'

/**
 * Pipeline-specific storage on the same connection `OrchestrationDb` owns, so the L4
 * instantiation transaction spans both the opaque `tasks`/`runs` rows and these tables.
 */
export class PipelineRunDb {
  private readonly db: Database.Database
  private readonly orchestrationDb: OrchestrationDb

  constructor(db: OrchestrationDb) {
    this.orchestrationDb = db
    this.db = db.getSyncDatabase()
    this.ensureSchema()
  }

  ensureSchema(): void {
    ensurePipelineRunSchema(this.db)
  }

  instantiate(args: InstantiatePipelineRunArgs): InstantiatePipelineRunResult {
    return instantiatePipelineRun(this.db, this.orchestrationDb, args)
  }

  recordWorktreeSetup(runId: string, args: { branch: string; runWorktreeId: string }): void {
    recordWorktreeSetup(this.db, runId, args)
  }

  getPipelineRun(runId: string): PipelineRunRow | undefined {
    return getPipelineRun(this.db, runId)
  }

  listPipelineRuns(filter?: { workspaceId?: string }): PipelineRunRow[] {
    return listPipelineRuns(this.db, filter)
  }

  getNodes(runId: string): PipelineNodeRow[] {
    return getPipelineNodes(this.db, runId)
  }

  getAttempts(runId: string, nodeId?: string): PipelineAttemptRow[] {
    return getPipelineAttempts(this.db, runId, nodeId)
  }

  updateRunState(runId: string, state: PipelineRunState, opts?: { failureReason?: string }): void {
    updateRunState(this.db, runId, state, opts)
  }

  beginAttempt(runId: string, nodeId: string, args: BeginAttemptArgs): void {
    beginAttempt(this.db, runId, nodeId, args)
  }

  endAttempt(runId: string, nodeId: string, attempt: number, args: EndAttemptArgs): void {
    endAttempt(this.db, runId, nodeId, attempt, args)
  }

  setNodeOutcome(runId: string, nodeId: string, args: { outcome: 'succeeded' | 'failed'; reason?: string }): void {
    setNodeOutcome(this.db, runId, nodeId, args)
  }

  incrementPrelaunchFailures(runId: string, nodeId: string): number {
    return incrementPrelaunchFailures(this.db, runId, nodeId)
  }

  resetPrelaunchFailures(runId: string, nodeId: string): void {
    resetPrelaunchFailures(this.db, runId, nodeId)
  }

  markOrphanedRunsInterrupted(): string[] {
    return markOrphanedRunsInterrupted(this.db)
  }
}
