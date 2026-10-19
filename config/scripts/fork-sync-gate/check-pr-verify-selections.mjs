#!/usr/bin/env node
/**
 * Proves `.github/workflows/pr.yml` can route every job its `verify` gate requires, so a sync never
 * pushes a workflow whose gate fails every PR with "missing or invalid selection".
 *
 * Checks, all against the working tree:
 * - every `check_job` selection read from `needs.code_paths.outputs.<k>` is a declared `code_paths`
 *   output, and one backed by `steps.filter` is a key `pr-code-change-scope.mjs` actually emits;
 * - every `needs.<job>.result` it reads names a job that exists and is listed in `verify.needs`;
 * - every repository script or local action the workflow runs exists.
 *
 * Exits 1 with one line per finding; prints nothing else on success unless `--verbose`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const WORKFLOW = '.github/workflows/pr.yml'
const SCOPE_SCRIPT = 'config/scripts/pr-code-change-scope.mjs'
const CHECK_JOB_CALL = /^\s*check_job\s+(\S+)\s+"\$(\w+)"\s+"\$(\w+)"/gm
const CODE_PATHS_OUTPUT = /needs\.code_paths\.outputs\.([\w-]+)/g
const STEP_OUTPUT = /steps\.([\w-]+)\.outputs\.([\w-]+)/g
const JOB_RESULT = /needs\.([\w-]+)\.result/g
const REPO_PATH = /(?<![\w$./-])((?:config|\.github)\/[\w./-]+\.(?:mjs|cjs|js|ts|sh|json|ya?ml))\b/g

function matches(pattern, text) {
  return [...String(text ?? '').matchAll(pattern)]
}

function verifyEnv(verifyJob) {
  const env = {}
  for (const step of verifyJob.steps ?? []) {
    Object.assign(env, step.env ?? {})
  }
  return env
}

/**
 * Findings for a parsed pr.yml. `emittedSelections` is the set of keys the scope script prints;
 * `pathExists` answers whether a repository-relative path is present.
 */
export function findVerifySelectionProblems(workflow, { emittedSelections, pathExists }) {
  const problems = []
  const jobs = workflow?.jobs ?? {}
  const verify = jobs.verify
  if (!verify) {
    return ['pr.yml has no verify job']
  }
  const verifyNeeds = new Set([verify.needs ?? []].flat())
  const codePathsOutputs = jobs.code_paths?.outputs ?? {}
  const env = verifyEnv(verify)
  const script = (verify.steps ?? []).map((step) => step.run ?? '').join('\n')

  for (const [, name, resultVar, shouldRunVar] of matches(CHECK_JOB_CALL, script)) {
    const shouldRun = env[shouldRunVar]
    if (shouldRun === undefined) {
      problems.push(`verify: check_job ${name} reads $${shouldRunVar}, which verify never sets`)
    }
    for (const [, output] of matches(CODE_PATHS_OUTPUT, shouldRun)) {
      const producer = codePathsOutputs[output]
      if (producer === undefined) {
        problems.push(
          `verify: check_job ${name} reads code_paths output "${output}", which code_paths never declares`
        )
        continue
      }
      for (const [, stepId, key] of matches(STEP_OUTPUT, producer)) {
        if (stepId === 'filter' && !emittedSelections.has(key)) {
          problems.push(
            `verify: check_job ${name} needs selection "${key}", which ${SCOPE_SCRIPT} never emits`
          )
        }
      }
    }
    for (const [, job] of matches(JOB_RESULT, env[resultVar])) {
      if (!jobs[job]) {
        problems.push(
          `verify: check_job ${name} reads the result of job "${job}", which does not exist`
        )
      } else if (!verifyNeeds.has(job)) {
        problems.push(`verify: check_job ${name} reads job "${job}", which verify does not need`)
      }
    }
  }

  for (const [jobName, job] of Object.entries(jobs)) {
    const referenced = new Set()
    if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
      referenced.add(job.uses.slice(2))
    }
    for (const step of job.steps ?? []) {
      if (typeof step.uses === 'string' && step.uses.startsWith('./')) {
        referenced.add(step.uses.slice(2))
      }
      for (const [, path] of matches(REPO_PATH, step.run)) {
        referenced.add(path)
      }
    }
    for (const path of referenced) {
      if (!pathExists(path)) {
        problems.push(`${jobName}: runs ${path}, which does not exist`)
      }
    }
  }
  return problems
}

/** Keys the scope script prints when every tracked file counts as changed. */
function emittedSelectionKeys() {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  const output = execFileSync('node', [SCOPE_SCRIPT], {
    encoding: 'utf8',
    input: files,
    maxBuffer: 1 << 26
  })
  return new Set(
    output
      .split('\n')
      .map((line) => line.split('=')[0].trim())
      .filter(Boolean)
  )
}

function main() {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8'))
  const problems = findVerifySelectionProblems(workflow, {
    emittedSelections: emittedSelectionKeys(),
    pathExists: (path) => existsSync(path)
  })
  if (problems.length > 0) {
    console.error(`${WORKFLOW} cannot route everything its verify gate requires:`)
    for (const problem of problems) {
      console.error(`  ${problem}`)
    }
    process.exit(1)
  }
  if (process.argv.includes('--verbose')) {
    console.log(`${WORKFLOW}: every verify selection has a producer and every script exists`)
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main()
}
