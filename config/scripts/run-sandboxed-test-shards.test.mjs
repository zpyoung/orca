import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { laneCommand } from './run-sandboxed-test-shards.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const workflow = (name) =>
  parse(readFileSync(resolve(projectDir, `.github/workflows/${name}.yml`), 'utf8'))

const shellRun = workflow('pr').jobs.shell_contracts.steps.find(
  (step) => step.name === 'Test real shell contracts'
).run
const unitRun = workflow('unit-tests').jobs.test.steps.find(
  (step) => step.name === 'Test shard'
).run

const shellSpecs = shellRun.match(/src\/\S+\.test\.ts/g)
const unitExcludes = unitRun.match(/--exclude=\S+/g)

describe('sandbox lane selection', () => {
  it('runs the CI shell contracts serially without stale spec paths', () => {
    const command = laneCommand({ lane: 'shell', extraArgs: [] }, 1)

    expect(command.filter((arg) => arg.endsWith('.test.ts')).sort()).toEqual(shellSpecs.sort())
    expect(command).toContain('--maxWorkers=1')
    expect(command.some((arg) => arg.startsWith('--shard='))).toBe(false)
    for (const spec of shellSpecs) {
      expect(existsSync(resolve(projectDir, spec)), spec).toBe(true)
    }
  })

  it('keeps the same shell contracts out of parallel shards as CI', () => {
    const command = laneCommand({ lane: 'unit', shardTotal: 16, extraArgs: [] }, 3)

    expect(command.filter((arg) => arg.startsWith('--exclude=')).sort()).toEqual(
      unitExcludes.sort()
    )
    expect(command).toContain('--shard=3/16')
  })
})
