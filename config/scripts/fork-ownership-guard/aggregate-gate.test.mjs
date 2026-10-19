import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  aggregateEnvironment,
  aggregateNeeds,
  aggregateRequiredJobs,
  aggregateShell,
  aggregateWorkflow
} from '../pr-aggregate-gate-context.mjs'
import { FORK_OWNERSHIP_GUARD_JOB } from './aggregate-gate-jobs.mjs'

const outcomes = ['failure', 'cancelled', 'skipped', '', 'unknown', undefined, null]

async function exitCodes(environments) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const cases = environments.map((environment, index) => {
    const exports = Object.entries(environment)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join('\n')
    return `(\n${exports}\n${aggregateShell.run}\n)\nprintf 'AGGREGATE_CASE_${index}=%s\\n' "$?"`
  })
  const directory = mkdtempSync(join(tmpdir(), 'orca-fork-guard-cases-'))
  try {
    const file = join(directory, 'cases.sh')
    writeFileSync(file, cases.join('\n'))
    const result = await runProcess({
      program: 'bash',
      args: [file],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
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

describe('fork ownership guard in the PR aggregate', () => {
  it('is required by verify and read from its own result, not a selector', () => {
    const verify = aggregateWorkflow.jobs.verify
    expect(verify.needs.slice(0, 3)).toEqual(['code_paths', 'preflight', FORK_OWNERSHIP_GUARD_JOB])
    expect(aggregateShell.env.FORK_OWNERSHIP_GUARD).toBe(
      `\${{ needs.${FORK_OWNERSHIP_GUARD_JOB}.result }}`
    )
    expect(aggregateShell.env.FORK_OWNERSHIP_GUARD_SHOULD_RUN).toBeUndefined()
    expect(aggregateShell.run).not.toContain('check_job fork_ownership_guard')
    expect(aggregateRequiredJobs).not.toContain(FORK_OWNERSHIP_GUARD_JOB)
  })

  it('fails the aggregate unless the guard succeeded, for code and docs-only plans', async () => {
    const environments = []
    const expected = []
    for (const selected of ['true', 'false']) {
      environments.push(aggregateEnvironment(aggregateNeeds(selected)))
      expected.push(0)
      for (const result of outcomes) {
        const needs = aggregateNeeds(selected)
        needs[FORK_OWNERSHIP_GUARD_JOB].result = result
        environments.push(aggregateEnvironment(needs))
        expected.push(1)
      }
      const missing = aggregateNeeds(selected)
      delete missing[FORK_OWNERSHIP_GUARD_JOB]
      environments.push(aggregateEnvironment(missing))
      expected.push(1)
    }
    expect(await exitCodes(environments)).toEqual(expected)
  })
})
