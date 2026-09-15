import type { Finding } from '../../shared/review/finding-schema'
import type { PrepassCheck, PrepassResult } from '../../shared/review/prepass-result-schema'

export const REVIEW_CHECK_TIMEOUT_MS = 900_000
export const MAX_REVIEW_CHECK_OUTPUT_CHARS = 4_000

export const REVIEW_CHECK_DISCOVERY = [
  { marker: 'pyproject.toml', command: 'python3 -m pytest -q' },
  { marker: 'package.json', command: 'pnpm test' },
  { marker: 'Cargo.toml', command: 'cargo test --quiet' }
] as const

export type ReviewProjectCheckConfig = {
  checks?: readonly string[]
  generatedOutputs?: readonly string[]
}

export type ReviewCheckPlan = {
  commands: string[]
  generatedOutputs: string[]
  source: 'project-config' | 'fallback'
}

export type ReviewCheckExecutionRequest = {
  command: string
  timeoutMs: number
  maxOutputChars: number
}

export type ReviewCheckExecutionResult = {
  exitCode: number
  stdout?: string
  stderr?: string
}

export type ReviewCheckExecutor = (
  request: ReviewCheckExecutionRequest
) => Promise<ReviewCheckExecutionResult>

export type ReviewPrepassCoreResult = Omit<PrepassResult, 'chain'>

function normalizeConfiguredStrings(values: readonly string[] | undefined): string[] {
  if (!values) {
    return []
  }
  return values.map((value) => value.trim()).filter(Boolean)
}

/** Select configured checks before consulting the pinned marker table. */
export function resolveReviewCheckPlan(args: {
  config?: ReviewProjectCheckConfig | null
  detectedMarkers: Iterable<string>
}): ReviewCheckPlan {
  const configuredChecks = normalizeConfiguredStrings(args.config?.checks)
  const generatedOutputs = normalizeConfiguredStrings(args.config?.generatedOutputs)
  if (configuredChecks.length > 0) {
    return {
      commands: configuredChecks,
      generatedOutputs,
      source: 'project-config'
    }
  }

  const detectedMarkers = new Set(args.detectedMarkers)
  return {
    commands: REVIEW_CHECK_DISCOVERY.filter(({ marker }) => detectedMarkers.has(marker)).map(
      ({ command }) => command
    ),
    generatedOutputs,
    source: 'fallback'
  }
}

export function retainReviewCheckOutputTail(output: string): string {
  return output.slice(-MAX_REVIEW_CHECK_OUTPUT_CHARS)
}

export function shapeReviewCheckResult(
  command: string,
  execution: ReviewCheckExecutionResult
): PrepassCheck {
  return {
    name: 'code-check',
    command,
    exit_code: execution.exitCode,
    status: execution.exitCode === 0 ? 'pass' : 'fail',
    output: retainReviewCheckOutputTail(`${execution.stdout ?? ''}${execution.stderr ?? ''}`)
  }
}

/** Execute sequentially; the host-aware adapter owns dispatch, abort, and tree-kill behavior. */
export async function runReviewChecks(
  commands: readonly string[],
  execute: ReviewCheckExecutor
): Promise<PrepassCheck[]> {
  const checks: PrepassCheck[] = []
  for (const command of commands) {
    const execution = await execute({
      command,
      timeoutMs: REVIEW_CHECK_TIMEOUT_MS,
      maxOutputChars: MAX_REVIEW_CHECK_OUTPUT_CHARS
    })
    checks.push(shapeReviewCheckResult(command, execution))
  }
  return checks
}

export function createFailedReviewCheckFinding(check: PrepassCheck): Finding {
  const evidenceOutput = check.output.slice(-2_000).trim() || `(no output; exit ${check.exit_code})`
  return {
    id: '',
    severity: 'HIGH',
    confidence: 'HIGH',
    category: 'failing-check',
    claim: `A repository check fails on this target: ${check.command} exited ${check.exit_code}.`,
    evidence: [
      {
        kind: 'prepass',
        ref: check.command,
        output: evidenceOutput
      }
    ],
    remediation: 'Make the check pass, or explain why its failure is expected here.',
    patch: null,
    stage: 'prepass'
  }
}

/** Add the generic findings that keep failed checks from silently producing PASS. */
export function shapeReviewPrepassCoreResult(args: {
  checks: readonly PrepassCheck[]
  observedArtifactHash: string | null
}): ReviewPrepassCoreResult {
  const checks = [...args.checks]
  const applicableChecks = checks.filter((check) => check.status !== 'not-applicable')
  const failedChecks = applicableChecks.filter((check) => check.status === 'fail')
  const status =
    applicableChecks.length === 0 ? 'could-not-run' : failedChecks.length > 0 ? 'fail' : 'pass'

  return {
    status,
    checks,
    findings: failedChecks.map(createFailedReviewCheckFinding),
    observed_artifact_hash: args.observedArtifactHash
  }
}
