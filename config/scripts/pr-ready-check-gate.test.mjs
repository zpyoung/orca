import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'
import { PR_CHECK_JOBS as CLASSIFIED_JOBS } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const PR_CHECK_JOBS = CLASSIFIED_JOBS.filter((job) => job in workflow.jobs)
const gate = workflow.jobs.verify.steps.find((step) => step.name === 'Require successful checks')
const variable = (job) => job.replaceAll('-', '_').toUpperCase()
const requiredJobs = [
  'preflight',
  ...PR_CHECK_JOBS.filter((job) => job !== 'static_analysis' && job !== 'typecheck')
]

function requiredResults(shouldRun) {
  return Object.fromEntries(
    requiredJobs.flatMap((job) => [
      [variable(job), shouldRun ? 'success' : 'skipped'],
      [`${variable(job)}_SHOULD_RUN`, String(shouldRun)]
    ])
  )
}

async function verify(results) {
  return runProcess({
    program: 'bash',
    args: ['-c', gate.run],
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      CODE_PATHS: 'success',
      FORK_OWNERSHIP_GUARD: 'success',
      SHOULD_RUN: 'true',
      ...results
    },
    timeoutMs: 10_000
  })
  const directory = mkdtempSync(join(tmpdir(), 'orca-aggregate-cases-'))
  const file = join(directory, 'cases.sh')
  try {
    writeFileSync(file, cases.join('\n'))
    const result = await runProcess({
      program: 'bash',
      args: [file],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env },
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    return [...result.stdout.matchAll(/^AGGREGATE_CASE_\d+=(\d+)$/gm)].map((match) =>
      Number(match[1])
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const malformedSelectors = [
  '',
  'TRUE',
  'True',
  'FALSE',
  '0',
  '1',
  'null',
  'unknown',
  ' true',
  'true\n',
  undefined,
  null
]
const outcomes = ['success', 'skipped', 'failure', 'cancelled', '', 'unknown', undefined, null]

// The aggregate runs as Bash on Linux; Windows has no required Bash installation.
describe.skipIf(process.platform === 'win32')(
  'required PR checks through the real aggregate shell',
  () => {
    it('accepts code, docs, reuse and mixed plans with their required outcomes', async () => {
      const plans = [aggregateNeeds('true'), aggregateNeeds('false')]
      for (const static_analysis of ['true', 'false']) {
        for (const typecheck of ['true', 'false']) {
          plans.push(aggregateNeeds('false', { static_analysis, typecheck }))
        }
      }
      plans.push(aggregateNeeds('false', { test: 'true', package: 'true', typecheck: 'true' }))
      for (const should_run of ['true', 'false', ...malformedSelectors]) {
        plans.push(aggregateNeeds('true', { should_run }))
      }
      expect(await verifyCases(plans.map(aggregateEnvironment), gate.run)).toEqual(
        plans.map(() => 0)
      )
    })

    it('rejects missing, failed, cancelled or incorrectly skipped required results', async () => {
      const cases = []
      const expected = []
      for (const selected of ['true', 'false']) {
        for (const job of ['code_paths', ...requiredJobs]) {
          for (const result of outcomes) {
            const needs = aggregateNeeds(selected)
            needs[job].result = result
            cases.push(aggregateEnvironment(needs))
            const correct = job === 'code_paths' || selected === 'true' ? 'success' : 'skipped'
            expected.push(result === correct ? 0 : 1)
          }
          const missing = aggregateNeeds(selected)
          delete missing[job]
          cases.push(aggregateEnvironment(missing))
          expected.push(1)
        }
      }
      expect(await verifyCases(cases, gate.run)).toEqual(expected)
    })

    it('rejects every malformed or masked raw selector even when downstream jobs were skipped', async () => {
      const cases = []
      for (const job of aggregateSelectors) {
        for (const selected of malformedSelectors) {
          cases.push(aggregateEnvironment(aggregateNeeds('false', { [job]: selected })))
          const missing = aggregateNeeds('false')
          delete missing.code_paths.outputs[job]
          cases.push(aggregateEnvironment(missing))
        }
      }
      expect(await verifyCases(cases, gate.run)).toEqual(cases.map(() => 1))
    })

    it('rejects malformed preflight phases even when the other phase selects preflight', async () => {
      const cases = []
      for (const phase of ['static_analysis', 'typecheck']) {
        const other = phase === 'static_analysis' ? 'typecheck' : 'static_analysis'
        for (const selected of malformedSelectors) {
          for (const otherSelected of ['true', 'false']) {
            for (const result of ['success', 'skipped']) {
              const needs = aggregateNeeds('false', { [phase]: selected, [other]: otherSelected })
              needs.preflight.result = result
              cases.push(aggregateEnvironment(needs))
            }
          }
        }
      }
      expect(await verifyCases(cases, gate.run)).toEqual(cases.map(() => 1))
    })
  }
)
