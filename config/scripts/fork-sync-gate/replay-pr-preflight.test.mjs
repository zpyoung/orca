import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { planSteps, substituteExpressions } from './replay-pr-preflight.mjs'

const context = { baseSha: 'abc123', changedCount: 812 }

describe('substituteExpressions', () => {
  it('fills the base SHA, changed count, sync selections and repo-variable defaults', () => {
    expect(
      substituteExpressions(
        "check ${{ github.event.pull_request.base.sha }} ${{ needs.code_paths.outputs.changed_count }} ${{ needs.code_paths.outputs.static_analysis == 'true' }} ${{ vars.MODE || 'shadow' }}",
        context
      )
    ).toEqual({ value: 'check abc123 812 true shadow' })
  })

  it('reports an expression it cannot evaluate instead of guessing', () => {
    expect(substituteExpressions('${{ steps.plan.outputs.shards }}', context)).toEqual({
      unknown: 'steps.plan.outputs.shards'
    })
  })
})

describe('planSteps', () => {
  // the shapes pr.yml's preflight job uses: gated phases, CI-only smoke steps, and a parallel typecheck
  const job = parse(`
steps:
  - uses: actions/checkout@v6
  - name: Lint
    if: '!cancelled()'
    env:
      PREFLIGHT_PHASE_SELECTED: \${{ needs.code_paths.outputs.static_analysis == 'true' }}
      PREFLIGHT_PRIOR_SUCCESS: \${{ job.status == 'success' }}
    run: node node_modules/oxlint/bin/oxlint
  - name: Enforce React Doctor on changed lines
    if: needs.code_paths.outputs.static_analysis == 'true'
    env:
      CHANGED_COUNT: \${{ needs.code_paths.outputs.changed_count }}
    run: node config/scripts/check-react-doctor-changed.mjs "\${{ github.event.pull_request.base.sha }}"
  - name: Boot orcad and round-trip a terminal
    if: steps.orcad-smoke-scope.outputs.run == 'true'
    run: pnpm run smoke:orcad-terminal
  - name: Test Mobile CI tools
    if: needs.code_paths.outputs.mobile_ci_tools == 'true'
    run: node config/scripts/run-vitest.mjs run
  - name: Typecheck
    run: pnpm run typecheck:ci --bun-concurrency=2
  - name: Upload plan
    run: echo "\${{ steps.unit-plan.outputs.shards }}"
`)

  it('runs gated phases with the selections a sync PR takes', () => {
    const [lint, reactDoctor] = planSteps(job, context)
    expect(lint).toEqual({
      name: 'Lint',
      script: 'node node_modules/oxlint/bin/oxlint',
      env: { PREFLIGHT_PHASE_SELECTED: 'true', PREFLIGHT_PRIOR_SUCCESS: 'true' }
    })
    expect(reactDoctor).toEqual({
      name: 'Enforce React Doctor on changed lines',
      script: 'node config/scripts/check-react-doctor-changed.mjs "abc123"',
      env: { CHANGED_COUNT: '812' }
    })
  })

  it('skips, with a reason, every step that cannot mean the same thing locally', () => {
    expect(planSteps(job, context).slice(2)).toEqual([
      {
        name: 'Boot orcad and round-trip a terminal',
        skip: "condition is CI-only: steps.orcad-smoke-scope.outputs.run == 'true'"
      },
      {
        name: 'Test Mobile CI tools',
        skip: "condition is CI-only: needs.code_paths.outputs.mobile_ci_tools == 'true'"
      },
      { name: 'Typecheck', skip: 'typecheck runs one project at a time in the sync gate instead' },
      {
        name: 'Upload plan',
        skip: 'uses an expression this replay cannot evaluate: steps.unit-plan.outputs.shards'
      }
    ])
  })
})
