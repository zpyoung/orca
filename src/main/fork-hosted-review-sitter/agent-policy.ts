import type { GitStatusResult } from '../../shared/git-status-types'

export type HostedReviewSitterPolicyViolation = {
  reason: string
  path?: string
}

const TEST_PATH =
  /(^|\/)(__tests__|tests?|specs?|fixtures)(\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i
const CI_DEFINITION_PATH =
  /(^|\/)(?:\.github\/workflows|\.circleci|\.buildkite|\.gitlab-ci(?:\.ya?ml)?|azure-pipelines(?:\.ya?ml)?|Jenkinsfile|bitrise\.ya?ml|package\.json|pnpm-workspace\.ya?ml)(\/|$)/i
const GATE_SCRIPT_PATH =
  /^(?:config|scripts|tools|ci)(?:\/[^/]+)*\/(?:check|verify|validate|lint|test|typecheck|audit)[^/]*$/i
const TEST_RUNNER_CONFIG_PATH =
  /(?:^|\/)(?:vitest|jest|playwright|cypress|mocha|ava|eslint|oxlint|biome)[^/]*\.(?:[cm]?[jt]s|jsonc?|ya?ml|toml)$/i
const CONFIGURED_TEST_GATE_PATH =
  /^config(?:\/[^/]+)*\/[^/]*(?:test|spec|e2e|unit|integration)[^/]*\.(?:[cm]?[jt]s|jsonc?|ya?ml|toml)$/i
const BASELINE_PATH = /(?:^|\/)[^/]*(?:baseline|ratchet)[^/]*(?:\/|$)/i
const ADDED_SUPPRESSION =
  /(?:eslint-disable|oxlint-disable|biome-ignore|prettier-ignore|@ts-ignore|@ts-nocheck|@SuppressWarnings|@Suppress\b|#\s*(?:noqa|type:\s*ignore)\b|\/\/\s*nolint\b|rubocop:disable|swiftlint:disable|pragma\s+warning\s+disable|lint-ignore)/i
const ADDED_TEST_BYPASS =
  /(?:\b(?:describe|context|suite|it|test)(?:\.[A-Za-z_$][\w$]*)*\.(?:skip|only|todo)\s*\(|\b(?:xdescribe|xcontext|xsuite|xit|xtest)\s*\(|\bpending\s*\(|@(?:Disabled|Ignore)\b|pytest\.mark\.(?:skip|xfail)\b|#\s*\[\s*ignore\s*\])/i
const ADDED_CI_BYPASS =
  /(?:\|\|\s*true\b|\bcontinue-on-error\s*:\s*true\b|\ballow_failure\s*:\s*true\b|--passWithNoTests\b|--no-error-on-unmatched-pattern\b|--no-verify\b|\bset\s+\+e\b|\bexit\s+0\b)/i
const TEST_CONTRACT =
  /(?:\b(?:describe|context|suite|it|test)\s*\(|\bexpect\s*\(|\bassert(?:\.|\s*\()|\bshould(?:\.|\s*\())/

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}
function isCiDefinitionPath(path: string): boolean {
  return (
    CI_DEFINITION_PATH.test(path) ||
    GATE_SCRIPT_PATH.test(path) ||
    TEST_RUNNER_CONFIG_PATH.test(path) ||
    CONFIGURED_TEST_GATE_PATH.test(path)
  )
}

function changedPaths(status: GitStatusResult): string[] {
  const paths = new Set<string>()
  for (const entry of status.entries) {
    paths.add(normalizePath(entry.path))
    if (entry.oldPath) {
      paths.add(normalizePath(entry.oldPath))
    }
  }
  return [...paths]
}

function patchLineCounts(patch: string): {
  addedSuppressions: number
  addedTestBypasses: number
  addedCiBypasses: number
  addedTestContracts: number
  removedTestContracts: number
} {
  let addedSuppressions = 0
  let addedTestBypasses = 0
  let addedCiBypasses = 0
  let addedTestContracts = 0
  let removedTestContracts = 0
  // File headers only appear outside a hunk; inside one "+++x" is content, and skipping it on
  // prefix alone lets an added `++i` or a removed `--prop` carry a suppression past the gate.
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) {
      continue
    }
    if (line.startsWith('+')) {
      const content = line.slice(1)
      if (ADDED_SUPPRESSION.test(content)) {
        addedSuppressions += 1
      }
      if (ADDED_TEST_BYPASS.test(content)) {
        addedTestBypasses += 1
      }
      if (ADDED_CI_BYPASS.test(content)) {
        addedCiBypasses += 1
      }
      if (TEST_CONTRACT.test(content)) {
        addedTestContracts += 1
      }
    } else if (line.startsWith('-') && TEST_CONTRACT.test(line.slice(1))) {
      removedTestContracts += 1
    }
  }
  return {
    addedSuppressions,
    addedTestBypasses,
    addedCiBypasses,
    addedTestContracts,
    removedTestContracts
  }
}

/**
 * Enforces the policy properties Git can prove without pretending to understand program semantics.
 * It deliberately rejects all CI-definition and baseline edits, and structural test weakening.
 * A semantic behavior change that keeps the same test/assertion shape remains reviewable, not proven safe.
 */
export function inspectHostedReviewSitterPolicy(
  status: GitStatusResult,
  patch: string
): HostedReviewSitterPolicyViolation | null {
  if (status.didHitLimit) {
    return { reason: 'working-tree-status-truncated' }
  }
  for (const entry of status.entries) {
    const path = normalizePath(entry.path)
    const oldPath = entry.oldPath ? normalizePath(entry.oldPath) : undefined
    if (BASELINE_PATH.test(path) || (oldPath !== undefined && BASELINE_PATH.test(oldPath))) {
      return { reason: 'quality-baseline-change-forbidden', path }
    }
    if (isCiDefinitionPath(path) || (oldPath !== undefined && isCiDefinitionPath(oldPath))) {
      return { reason: 'ci-definition-change-requires-human-review', path }
    }
    if (
      entry.status === 'deleted' &&
      (TEST_PATH.test(path) || (oldPath !== undefined && TEST_PATH.test(oldPath)))
    ) {
      return { reason: 'test-deletion-forbidden', path }
    }
    if (
      entry.status === 'renamed' &&
      oldPath !== undefined &&
      TEST_PATH.test(oldPath) &&
      !TEST_PATH.test(path)
    ) {
      return { reason: 'test-moved-out-of-suite-forbidden', path }
    }
    if (entry.conflictStatus === 'unresolved') {
      return { reason: 'unresolved-conflict', path }
    }
  }

  const counts = patchLineCounts(patch)
  if (counts.addedSuppressions > 0) {
    return { reason: 'new-lint-or-type-suppression-forbidden' }
  }
  if (counts.addedTestBypasses > 0) {
    return { reason: 'test-skip-focus-or-todo-forbidden' }
  }
  if (counts.addedCiBypasses > 0) {
    return { reason: 'ci-failure-bypass-forbidden' }
  }
  if (
    changedPaths(status).some((path) => TEST_PATH.test(path)) &&
    counts.removedTestContracts > counts.addedTestContracts
  ) {
    return { reason: 'test-contract-narrowing-forbidden' }
  }
  return null
}

export function getHostedReviewSitterChangedPaths(status: GitStatusResult): string[] {
  return changedPaths(status)
}
