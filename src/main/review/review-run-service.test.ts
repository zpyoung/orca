import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalReviewFilesystem } from './review-local-filesystem'
import { MAX_REVIEW_RUNS_PER_WORKSPACE } from './review-run-contract'
import { ReviewRunService } from './review-run-service'

const roots: string[] = []

async function service(): Promise<{ root: string; service: ReviewRunService }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-review-run-'))
  roots.push(root)
  return {
    root,
    service: new ReviewRunService({
      id: 'workspace-1',
      rootPath: root,
      filesystem: createLocalReviewFilesystem()
    })
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ReviewRunService', () => {
  it('creates, lists, shows, fails, and aborts runs', async () => {
    const fixture = await service()
    const first = (await fixture.service.create({ depth: 'deep', profile: 'spec-design' })).run
    const second = (await fixture.service.create()).run

    expect(first.run_id).toMatch(/^[0-9a-f]{16}$/)
    expect(first).toMatchObject({
      workspace_id: 'workspace-1',
      state: 'running',
      depth: 'deep',
      profile: 'spec-design'
    })
    expect((await fixture.service.list()).runs.map((run) => run.run_id)).toEqual([
      second.run_id,
      first.run_id
    ])
    expect(await fixture.service.show(first.run_id)).toMatchObject({ found: true, run: first })

    const failed = await fixture.service.fail(first.run_id, 'reviewer failed')
    expect(failed.failed).toBe(true)
    expect(failed.run.state).toBe('failed')
    expect(
      await readFile(
        join(fixture.root, '.orca-review', 'runs', first.run_id, 'failure.json'),
        'utf8'
      )
    ).toContain('reviewer failed')
    expect((await fixture.service.fail(first.run_id)).failed).toBe(false)
    expect((await fixture.service.abort(second.run_id)).aborted).toBe(true)
    expect((await fixture.service.abort(second.run_id)).aborted).toBe(false)
  })

  it('retains running runs and evicts oldest terminal runs at the cap', async () => {
    const fixture = await service()
    const created: string[] = []
    for (let index = 0; index < MAX_REVIEW_RUNS_PER_WORKSPACE + 2; index++) {
      const run = (await fixture.service.create()).run
      created.push(run.run_id)
      if (index < 3) {
        await fixture.service.fail(run.run_id)
      }
    }

    const listed = await fixture.service.list()
    expect(listed.runs).toHaveLength(MAX_REVIEW_RUNS_PER_WORKSPACE)
    expect(listed.runs.some((run) => run.run_id === created[0])).toBe(false)
    expect(listed.runs.filter((run) => run.state === 'running')).toHaveLength(
      MAX_REVIEW_RUNS_PER_WORKSPACE - 1
    )
  })

  it('publishes run JSON atomically without leaving temporary files', async () => {
    const fixture = await service()
    const run = (await fixture.service.create()).run
    const directory = join(fixture.root, '.orca-review', 'runs', run.run_id)
    expect(await readdir(directory)).not.toContain('run.json.tmp')
    expect(JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'))).toEqual(run)
  })

  it('dismisses only accepted findings from the run campaign', async () => {
    const fixture = await service()
    const created = (await fixture.service.create()).run
    const runPath = join(fixture.root, '.orca-review', 'runs', created.run_id, 'run.json')
    const campaignHash = 'a'.repeat(64)
    await writeFile(runPath, JSON.stringify({ ...created, campaign_hash: campaignHash }))
    const campaignPath = join(fixture.root, '.orca-review', 'campaigns', `${campaignHash}.json`)
    await writeFile(
      campaignPath,
      JSON.stringify({
        campaign_hash: campaignHash,
        target_kind: 'worktree',
        scope: '.',
        baseline: null,
        profile: 'code-diff',
        criteria: 'works',
        protocol_version: created.protocol_version,
        dismissed: [],
        accepted_open: [
          {
            id: 'F1',
            run_id: created.run_id,
            claim: 'broken',
            category: 'correctness',
            effective_severity: 'HIGH',
            evidence_refs: ['src/a.ts:1']
          }
        ],
        runs: [created.run_id]
      })
    )

    expect((await fixture.service.dismiss(created.run_id, 'F2', 'not relevant')).dismissed).toBe(
      false
    )
    expect((await fixture.service.dismiss(created.run_id, 'F1', 'not relevant')).dismissed).toBe(
      true
    )
    const campaign = JSON.parse(await readFile(campaignPath, 'utf8'))
    expect(campaign.accepted_open).toEqual([])
    expect(campaign.dismissed[0]).toMatchObject({ id: 'F1', reason: 'not relevant' })
  })
})
