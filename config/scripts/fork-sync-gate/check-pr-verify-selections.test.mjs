import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { findVerifySelectionProblems } from './check-pr-verify-selections.mjs'

// shaped after v1.4.230's pr.yml, whose release branch shipped dependency_isolation without routing
function workflow({ verifyNeeds = ['code_paths', 'lint', 'dependency_isolation'] } = {}) {
  return parse(`
jobs:
  code_paths:
    outputs:
      lint: \${{ steps.readiness.outputs.reused != 'true' && steps.filter.outputs.lint }}
      dependency_isolation: \${{ steps.filter.outputs.dependency_isolation }}
    steps:
      - id: filter
        run: node config/scripts/pr-code-change-scope.mjs
  lint:
    steps:
      - uses: ./.github/actions/install-node-dependencies
      - run: node config/scripts/check-lint.mjs
  dependency_isolation:
    steps:
      - run: pnpm exec vitest run config/scripts/undeclared-dependency-resolution.test.ts
  verify:
    needs: ${JSON.stringify(verifyNeeds)}
    steps:
      - env:
          LINT: \${{ needs.lint.result }}
          LINT_SHOULD_RUN: \${{ needs.code_paths.outputs.lint }}
          DEPENDENCY_ISOLATION: \${{ needs.dependency_isolation.result }}
          DEPENDENCY_ISOLATION_SHOULD_RUN: \${{ needs.code_paths.outputs.dependency_isolation }}
        run: |
          check_job lint "$LINT" "$LINT_SHOULD_RUN"
          check_job dependency_isolation "$DEPENDENCY_ISOLATION" "$DEPENDENCY_ISOLATION_SHOULD_RUN"
`)
}

const present = new Set([
  '.github/actions/install-node-dependencies',
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/check-lint.mjs',
  'config/scripts/undeclared-dependency-resolution.test.ts'
])
const pathExists = (path) => present.has(path)

describe('findVerifySelectionProblems', () => {
  it('accepts a workflow whose every selection is emitted and every script exists', () => {
    expect(
      findVerifySelectionProblems(workflow(), {
        emittedSelections: new Set(['lint', 'dependency_isolation']),
        pathExists
      })
    ).toEqual([])
  })

  it('names a verify selection the scope script never emits', () => {
    expect(
      findVerifySelectionProblems(workflow(), {
        emittedSelections: new Set(['lint']),
        pathExists
      })
    ).toEqual([
      'verify: check_job dependency_isolation needs selection "dependency_isolation", which config/scripts/pr-code-change-scope.mjs never emits'
    ])
  })

  it('names a script the workflow runs that the tree does not have', () => {
    const missingTest = (path) =>
      path !== 'config/scripts/undeclared-dependency-resolution.test.ts' && pathExists(path)
    expect(
      findVerifySelectionProblems(workflow(), {
        emittedSelections: new Set(['lint', 'dependency_isolation']),
        pathExists: missingTest
      })
    ).toEqual([
      'dependency_isolation: runs config/scripts/undeclared-dependency-resolution.test.ts, which does not exist'
    ])
  })

  it('names a checked job that verify does not wait for', () => {
    expect(
      findVerifySelectionProblems(workflow({ verifyNeeds: ['code_paths', 'lint'] }), {
        emittedSelections: new Set(['lint', 'dependency_isolation']),
        pathExists
      })
    ).toEqual([
      'verify: check_job dependency_isolation reads job "dependency_isolation", which verify does not need'
    ])
  })

  it('ignores selections produced by steps other than the scope filter', () => {
    const fromE2eFilter = workflow()
    fromE2eFilter.jobs.code_paths.outputs.dependency_isolation =
      '${{ steps.e2e_filter.outputs.should_run }}'
    expect(
      findVerifySelectionProblems(fromE2eFilter, {
        emittedSelections: new Set(['lint']),
        pathExists
      })
    ).toEqual([])
  })
})
