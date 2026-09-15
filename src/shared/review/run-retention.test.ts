import { describe, expect, it } from 'vitest'
import { planReviewRunRetention, pruneReviewRuns } from './run-retention'
import type { ReviewRetentionEntry } from './run-retention'

const run = (
  run_id: string,
  created_at: string,
  state: ReviewRetentionEntry['state'] = 'completed',
  campaign_hash: string | null = 'campaign'
): ReviewRetentionEntry => ({ run_id, created_at, state, campaign_hash })

describe('review run retention', () => {
  it('keeps the newest terminal runs and preserves source order', () => {
    const runs = [run('old', '2026-01-01'), run('new', '2026-01-03'), run('middle', '2026-01-02')]
    expect(pruneReviewRuns(runs, 2).map((item) => item.run_id)).toEqual(['new', 'middle'])
  })

  it('never evicts a running run, using it as part of the workspace cap', () => {
    const runs = [
      run('running', '2026-01-01', 'running'),
      run('old', '2026-01-02'),
      run('new', '2026-01-03')
    ]
    expect(pruneReviewRuns(runs, 2).map((item) => item.run_id)).toEqual(['running', 'new'])
  })

  it('keeps all active runs when they alone exceed the cap', () => {
    const runs = [run('a', '1', 'running'), run('b', '2', 'running'), run('done', '3')]
    expect(pruneReviewRuns(runs, 1).map((item) => item.run_id)).toEqual(['a', 'b'])
  })

  it('orphans a campaign only when no surviving run references it', () => {
    const plan = planReviewRunRetention(
      [
        run('a-old', '1', 'completed', 'a'),
        run('a-new', '3', 'completed', 'a'),
        run('b', '2', 'failed', 'b')
      ],
      1,
      ['a', 'b', 'never-used']
    )
    expect(plan.kept.map((item) => item.run_id)).toEqual(['a-new'])
    expect(plan.evicted.map((item) => item.run_id)).toEqual(['a-old', 'b'])
    expect(plan.orphanedCampaignHashes).toEqual(['b', 'never-used'])
  })
})
