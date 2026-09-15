import { randomBytes } from 'node:crypto'
import { resolveRuntimePath } from '../../shared/cross-platform-path'
import { CampaignSchema, type Campaign } from '../../shared/review/campaign-schema'
import { ORCA_REVIEW_PROTOCOL_VERSION } from '../../shared/review/protocol-assets'
import {
  RunRecordSchema,
  type ReviewRunState,
  type RunRecord
} from '../../shared/review/stage-schemas'
import type { DirEntry } from '../../shared/types'
import {
  MAX_REVIEW_RUNS_PER_WORKSPACE,
  type ReviewRunCreateInput,
  type ReviewRunShowResult,
  type ReviewStalenessResult,
  type ReviewWorkspace
} from './review-run-contract'
const RUN_ID_PATTERN = /^[0-9a-f]{16}$/
let lastCreatedAtMs = 0
const TERMINAL_STATES = new Set<ReviewRunState>(['completed', 'failed', 'aborted', 'interrupted'])

export class ReviewRunService {
  constructor(private readonly workspace: ReviewWorkspace) {}

  async create(input: ReviewRunCreateInput = {}): Promise<{ run: RunRecord; created: true }> {
    await this.ensureRoots()
    const runId = randomBytes(8).toString('hex')
    const now = nextCreatedAt()
    const run: RunRecord = {
      run_id: runId,
      workspace_id: this.workspace.id,
      state: 'running',
      verdict: null,
      campaign_hash: null,
      orchestration_run_id: input.orchestrationRunId ?? `pending:${runId}`,
      driver_terminal_handle: input.driverTerminalHandle ?? `pending:${runId}`,
      depth: input.depth ?? 'standard',
      profile: input.profile ?? 'code-diff',
      created_at: now,
      updated_at: now,
      protocol_version: ORCA_REVIEW_PROTOCOL_VERSION
    }
    const runDirectory = this.runDirectory(runId)
    await this.workspace.filesystem.createDir(runDirectory)
    await this.workspace.filesystem.createDir(this.path(runDirectory, 'stages'))
    await this.workspace.filesystem.createDir(this.path(runDirectory, 'artifact'))
    await this.writeJson(this.path(runDirectory, 'run.json'), run)
    await this.prune()
    return { run, created: true }
  }

  async list(): Promise<{ runs: RunRecord[] }> {
    const entries = await this.readDirOrEmpty(this.runsRoot())
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory && RUN_ID_PATTERN.test(entry.name))
        .map((entry) => this.readRunOrNull(entry.name))
    )
    return {
      runs: runs
        .filter((run): run is RunRecord => run !== null)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
    }
  }

  async show(runId: string): Promise<ReviewRunShowResult> {
    const run = await this.requireRun(runId)
    const manifest = await this.readJsonOrNull(this.path(this.runDirectory(runId), 'manifest.json'))
    return { found: true, run, ...(manifest === null ? {} : { manifest }) }
  }

  async abort(runId: string): Promise<{ run: RunRecord; aborted: boolean }> {
    const current = await this.requireRun(runId)
    if (current.state !== 'running') {
      return { run: current, aborted: false }
    }
    const run = await this.transition(current, 'aborted')
    return { run, aborted: true }
  }

  async fail(runId: string, reason?: string): Promise<{ run: RunRecord; failed: boolean }> {
    const current = await this.requireRun(runId)
    if (current.state !== 'running') {
      return { run: current, failed: false }
    }
    if (reason) {
      await this.writeJson(this.path(this.runDirectory(runId), 'failure.json'), {
        reason,
        failed_at: new Date().toISOString()
      })
    }
    const run = await this.transition(current, 'failed')
    return { run, failed: true }
  }

  async dismiss(
    runId: string,
    findingId: string,
    reason: string
  ): Promise<{ run: RunRecord; finding: string; dismissed: boolean }> {
    const run = await this.requireRun(runId)
    if (!run.campaign_hash) {
      return { run, finding: findingId, dismissed: false }
    }
    const campaignPath = this.path(this.campaignsRoot(), `${run.campaign_hash}.json`)
    const campaign = CampaignSchema.parse(await this.readJson(campaignPath))
    const finding = campaign.accepted_open.find((candidate) => candidate.id === findingId)
    if (!finding) {
      return { run, finding: findingId, dismissed: false }
    }
    const updated: Campaign = {
      ...campaign,
      accepted_open: campaign.accepted_open.filter((candidate) => candidate.id !== findingId),
      dismissed: [
        ...campaign.dismissed,
        {
          id: finding.id,
          run_id: finding.run_id,
          claim: finding.claim,
          category: finding.category,
          effective_severity: finding.effective_severity,
          reason,
          dismissed_at: new Date().toISOString()
        }
      ]
    }
    await this.writeJson(campaignPath, updated)
    return { run, finding: findingId, dismissed: true }
  }

  async staleness(runId: string): Promise<ReviewStalenessResult> {
    await this.requireRun(runId)
    const capturePath = this.path(this.runDirectory(runId), 'capture.json')
    const capture = await this.readJsonOrNull(capturePath)
    const checkedAt = new Date().toISOString()
    if (capture === null) {
      return {
        run: runId,
        stale: false,
        available: false,
        reason: 'capture-unavailable',
        checkedAt
      }
    }
    // Re-derivation is target/provider-specific and is attached by review-artifact-capture.
    return {
      run: runId,
      stale: false,
      available: false,
      reason: 'rederivation-unavailable',
      checkedAt
    }
  }

  async prune(): Promise<{ evicted: string[] }> {
    const { runs } = await this.list()
    let excess = runs.length - MAX_REVIEW_RUNS_PER_WORKSPACE
    if (excess <= 0) {
      return { evicted: [] }
    }
    const candidates = runs.toReversed().filter((run) => TERMINAL_STATES.has(run.state))
    const evicted: string[] = []
    for (const run of candidates) {
      if (excess <= 0) {
        break
      }
      await this.workspace.filesystem.deletePath(this.runDirectory(run.run_id), true)
      evicted.push(run.run_id)
      excess--
    }
    await this.pruneUnreferencedCampaigns()
    return { evicted }
  }

  private async pruneUnreferencedCampaigns(): Promise<void> {
    const { runs } = await this.list()
    const referenced = new Set(
      runs.map((run) => run.campaign_hash).filter((hash): hash is string => hash !== null)
    )
    const entries = await this.readDirOrEmpty(this.campaignsRoot())
    await Promise.all(
      entries
        .filter(
          (entry) =>
            !entry.isDirectory &&
            entry.name.endsWith('.json') &&
            !referenced.has(entry.name.slice(0, -5))
        )
        .map((entry) =>
          this.workspace.filesystem.deletePath(this.path(this.campaignsRoot(), entry.name))
        )
    )
  }

  private async transition(current: RunRecord, state: ReviewRunState): Promise<RunRecord> {
    const run = RunRecordSchema.parse({
      ...current,
      state,
      updated_at: new Date().toISOString()
    })
    await this.writeJson(this.path(this.runDirectory(current.run_id), 'run.json'), run)
    return run
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error('invalid_review_run_id')
    }
    const run = await this.readRunOrNull(runId)
    if (!run) {
      throw new Error('review_run_not_found')
    }
    return run
  }

  private async readRunOrNull(runId: string): Promise<RunRecord | null> {
    const value = await this.readJsonOrNull(this.path(this.runDirectory(runId), 'run.json'))
    if (value === null) {
      return null
    }
    const parsed = RunRecordSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.tmp`
    await this.workspace.filesystem.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
    await this.workspace.filesystem.rename(temporaryPath, path)
  }

  private async readJson(path: string): Promise<unknown> {
    return JSON.parse((await this.workspace.filesystem.readFile(path)).content)
  }

  private async readJsonOrNull(path: string): Promise<unknown | null> {
    try {
      return await this.readJson(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        return null
      }
      throw error
    }
  }

  private async readDirOrEmpty(path: string): Promise<DirEntry[]> {
    try {
      return await this.workspace.filesystem.readDir(path)
    } catch (error) {
      if (isMissingPathError(error)) {
        return []
      }
      throw error
    }
  }

  private async ensureRoots(): Promise<void> {
    await this.workspace.filesystem.createDir(this.reviewRoot())
    await this.workspace.filesystem.createDir(this.runsRoot())
    await this.workspace.filesystem.createDir(this.campaignsRoot())
  }

  private reviewRoot(): string {
    return this.path(this.workspace.rootPath, '.orca-review')
  }
  private runsRoot(): string {
    return this.path(this.reviewRoot(), 'runs')
  }
  private campaignsRoot(): string {
    return this.path(this.reviewRoot(), 'campaigns')
  }
  private runDirectory(runId: string): string {
    return this.path(this.runsRoot(), runId)
  }
  private path(base: string, child: string): string {
    return resolveRuntimePath(base, child)
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const value = error as { code?: unknown; message?: unknown }
  return value.code === 'ENOENT' || String(value.message ?? '').includes('ENOENT')
}

function nextCreatedAt(): string {
  lastCreatedAtMs = Math.max(Date.now(), lastCreatedAtMs + 1)
  return new Date(lastCreatedAtMs).toISOString()
}
