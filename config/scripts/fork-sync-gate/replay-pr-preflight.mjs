#!/usr/bin/env node
/**
 * Runs the `run:` steps of a `.github/workflows/pr.yml` job (default `preflight`) locally, in order,
 * and reports every failure in one pass, so a sync finds what CI's static-analysis job would reject
 * before pushing instead of one CI round per failing step.
 *
 * It reads the workflow rather than a kept list, so it follows upstream's step changes. A step is
 * skipped, and named in the report, when it cannot mean the same thing locally: its condition reads
 * another step's output or a selection a sync PR never takes, it uses an expression this script
 * cannot evaluate, or it is a typecheck, which the sync gate runs one project at a time.
 *
 * Usage: replay-pr-preflight.mjs [--job <id>] [--base <ref>] [--only <name substring>]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const WORKFLOW = '.github/workflows/pr.yml'
const STEP_TIMEOUT_MS = 20 * 60 * 1000
const ALWAYS_CONDITIONS = new Set(['', '!cancelled()', 'success()', 'always()'])
// selections every sync-sized PR takes; anything else may be false on a real PR
const SYNC_SELECTIONS = new Set(['static_analysis', 'typecheck'])
const EXPRESSION = /\$\{\{\s*([^}]*?)\s*\}\}/g

/** The value of one `${{ }}` expression, or undefined when it cannot be evaluated locally. */
export function evaluateExpression(expression, context) {
  const selection = /^needs\.code_paths\.outputs\.([\w-]+)\s*==\s*'true'$/.exec(expression)
  if (selection) {
    return SYNC_SELECTIONS.has(selection[1]) ? 'true' : undefined
  }
  const repoVariable = /^vars\.\w+\s*\|\|\s*'([^']*)'$/.exec(expression)
  if (repoVariable) {
    return repoVariable[1]
  }
  switch (expression) {
    case 'github.event.pull_request.base.sha':
      return context.baseSha
    case 'needs.code_paths.outputs.changed_count':
      return String(context.changedCount)
    case "job.status == 'success'":
      return 'true'
    default:
      return undefined
  }
}

/** `text` with every expression substituted, or `{ unknown }` naming the first one it cannot. */
export function substituteExpressions(text, context) {
  let unknown
  const value = String(text).replace(EXPRESSION, (whole, expression) => {
    const result = evaluateExpression(expression, context)
    if (result === undefined) {
      unknown ??= expression
      return whole
    }
    return result
  })
  return unknown === undefined ? { value } : { unknown }
}

function conditionVerdict(condition) {
  const text = String(condition ?? '').trim()
  if (ALWAYS_CONDITIONS.has(text)) {
    return { run: true }
  }
  const selection = /^needs\.code_paths\.outputs\.([\w-]+)\s*==\s*'true'$/.exec(text)
  if (selection && SYNC_SELECTIONS.has(selection[1])) {
    return { run: true }
  }
  return { run: false, reason: `condition is CI-only: ${text}` }
}

/** One entry per step: `{ name, script, env }` to run, or `{ name, skip }` with the reason. */
export function planSteps(job, context) {
  const plan = []
  for (const [index, step] of (job.steps ?? []).entries()) {
    if (typeof step.run !== 'string') {
      continue
    }
    const name = step.name ?? step.id ?? `step ${index}`
    const verdict = conditionVerdict(step.if)
    if (!verdict.run) {
      plan.push({ name, skip: verdict.reason })
      continue
    }
    if (/\btypecheck(:ci)?\b/.test(step.run) && /pnpm (run )?typecheck/.test(step.run)) {
      plan.push({ name, skip: 'typecheck runs one project at a time in the sync gate instead' })
      continue
    }
    const env = {}
    const unknown = []
    for (const [key, raw] of Object.entries({ ...job.env, ...step.env })) {
      const result = substituteExpressions(raw, context)
      if (result.unknown !== undefined) {
        unknown.push(result.unknown)
      }
      env[key] = result.value
    }
    const script = substituteExpressions(step.run, context)
    if (script.unknown !== undefined) {
      unknown.push(script.unknown)
    }
    if (unknown.length > 0) {
      plan.push({
        name,
        skip: `uses an expression this replay cannot evaluate: ${unknown.join(', ')}`
      })
      continue
    }
    plan.push({ name, script: script.value, env })
  }
  return plan
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()
}

function option(name, fallback) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

function main() {
  const jobId = option('--job', 'preflight')
  const only = option('--only')
  const baseSha = git(['merge-base', option('--base', 'origin/main'), 'HEAD'])
  const changedCount = git(['diff', '--name-only', '--no-renames', baseSha, 'HEAD'])
    .split('\n')
    .filter(Boolean).length
  const job = parse(readFileSync(WORKFLOW, 'utf8'))?.jobs?.[jobId]
  if (!job) {
    console.error(`${WORKFLOW} has no job "${jobId}"`)
    process.exit(2)
  }
  const plan = planSteps(job, { baseSha, changedCount }).filter(
    (step) => !only || step.name.includes(only)
  )
  const scratch = mkdtempSync(join(tmpdir(), 'replay-pr-preflight-'))
  const runnerFiles = {
    GITHUB_OUTPUT: join(scratch, 'output'),
    GITHUB_ENV: join(scratch, 'env'),
    GITHUB_STEP_SUMMARY: join(scratch, 'summary')
  }
  for (const file of Object.values(runnerFiles)) {
    writeFileSync(file, '')
  }
  // workflow steps call bun and other tools by bare name; the repo pins them in node_modules/.bin
  const path = [resolve('node_modules/.bin'), process.env.PATH].join(delimiter)
  console.log(
    `Replaying ${WORKFLOW} job ${jobId} against ${baseSha.slice(0, 10)} (${changedCount} changed files)`
  )

  const failures = []
  for (const [index, step] of plan.entries()) {
    if (step.skip) {
      console.log(`SKIP  ${step.name} (${step.skip})`)
      continue
    }
    const log = join(scratch, `step-${index}.log`)
    const started = Date.now()
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', step.script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...step.env,
        ...runnerFiles,
        CI: 'true',
        PATH: path,
        RUNNER_TEMP: scratch
      },
      maxBuffer: 1 << 28,
      timeout: STEP_TIMEOUT_MS,
      windowsHide: true
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    writeFileSync(log, output)
    const seconds = Math.round((Date.now() - started) / 1000)
    if (result.status === 0) {
      console.log(`PASS  ${step.name} (${seconds}s)`)
      continue
    }
    const why = result.error ? result.error.message : `exit ${result.status}`
    console.log(`FAIL  ${step.name} (${why}, ${seconds}s): ${log}`)
    console.log(
      output
        .trimEnd()
        .split('\n')
        .slice(-30)
        .map((line) => `      ${line}`)
        .join('\n')
    )
    failures.push(step.name)
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} step(s) failed: ${failures.join(', ')}`)
    process.exit(1)
  }
  console.log('\nEvery replayable step succeeded.')
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main()
}
