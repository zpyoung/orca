#!/usr/bin/env node
/**
 * Waits on a sync PR's checks and exits on the first thing the run must act on, so Step 10 waits
 * with one background command instead of a hand-written poll loop.
 *
 * Gating checks are the jobs of the `PR Checks` workflow (`pr.yml`), whose `PR checks passed` job is
 * the merge gate; every other workflow's check is advisory. Once the gate succeeds the wait gives
 * advisory checks up to `--advisory-minutes` to settle, then reports them rather than blocking.
 *
 * Exit codes: 0 merge-ready, 1 a gating check failed, 2 timed out, 3 the head moved (another
 * writer pushed), 4 the PR is no longer open, 5 the wait could not read the PR.
 *
 * Usage: wait-pr-checks.mjs --pr <n> --head <sha> [--repo <owner/name>] [--interval-seconds 120]
 *        [--advisory-minutes 15] [--timeout-minutes 240]
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const GATE_WORKFLOW = 'PR Checks'
export const GATE_CHECK = 'PR checks passed'
const FAILED = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR'
])
const SETTLED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL', ...FAILED])

function normalize(entry) {
  if (entry.__typename === 'StatusContext') {
    const state = String(entry.state ?? '').toUpperCase()
    return {
      name: entry.context,
      workflow: '',
      conclusion: state === 'PENDING' || state === 'EXPECTED' ? '' : state,
      url: entry.targetUrl ?? ''
    }
  }
  return {
    name: entry.name,
    workflow: entry.workflowName ?? '',
    conclusion: entry.status === 'COMPLETED' ? String(entry.conclusion ?? '').toUpperCase() : '',
    url: entry.detailsUrl ?? ''
  }
}

/** Where a PR's checks stand: the gate's state, plus gating and advisory checks needing attention. */
export function classifyRollup(rollup) {
  const checks = (rollup ?? []).map(normalize)
  const gating = checks.filter((check) => check.workflow === GATE_WORKFLOW)
  const advisory = checks.filter((check) => check.workflow !== GATE_WORKFLOW)
  const gate = gating.find((check) => check.name === GATE_CHECK)
  let gateState = 'pending'
  if (gate?.conclusion === 'SUCCESS') {
    gateState = 'success'
  } else if (gate && FAILED.has(gate.conclusion)) {
    gateState = 'failure'
  }
  return {
    gate: gateState,
    gatingFailures: gating.filter((check) => FAILED.has(check.conclusion)),
    advisoryFailures: advisory.filter((check) => FAILED.has(check.conclusion)),
    advisoryPending: advisory.filter((check) => !SETTLED.has(check.conclusion))
  }
}

function option(name, fallback) {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}

function readPr(repo, pr) {
  // an ambient GITHUB_TOKEN overrides gh's keyring login, which is the one with access to the fork
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  const output = execFileSync(
    'gh',
    ['pr', 'view', pr, '--repo', repo, '--json', 'state,headRefOid,statusCheckRollup'],
    { encoding: 'utf8', env, maxBuffer: 1 << 26, windowsHide: true }
  )
  return JSON.parse(output)
}

function list(label, checks) {
  for (const check of checks) {
    console.log(
      `${label} ${check.name} [${check.workflow || 'status'}] ${check.conclusion || 'PENDING'} ${check.url}`
    )
  }
}

function pause(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

function main() {
  const pr = option('--pr')
  const head = option('--head')
  if (!pr || !head) {
    console.error('usage: wait-pr-checks.mjs --pr <n> --head <sha>')
    process.exit(5)
  }
  const repo = option('--repo', 'zpyoung/orca')
  const intervalSeconds = Number(option('--interval-seconds', '120'))
  const advisoryMs = Number(option('--advisory-minutes', '15')) * 60_000
  const deadline = Date.now() + Number(option('--timeout-minutes', '240')) * 60_000
  let gateGreenAt = 0
  let readFailures = 0

  while (Date.now() < deadline) {
    let view
    try {
      view = readPr(repo, pr)
      readFailures = 0
    } catch (error) {
      readFailures += 1
      console.error(
        `could not read PR #${pr} (${readFailures}/5): ${String(error.stderr ?? error.message).trim()}`
      )
      if (readFailures >= 5) {
        process.exit(5)
      }
      pause(intervalSeconds)
      continue
    }
    if (view.state !== 'OPEN') {
      console.log(`PR #${pr} is ${view.state}`)
      process.exit(4)
    }
    if (!view.headRefOid.startsWith(head)) {
      console.log(`PR #${pr} head moved from ${head} to ${view.headRefOid}: another writer pushed`)
      process.exit(3)
    }
    const status = classifyRollup(view.statusCheckRollup)
    if (status.gatingFailures.length > 0) {
      list('GATING FAILED', status.gatingFailures)
      process.exit(1)
    }
    if (status.gate === 'success') {
      gateGreenAt ||= Date.now()
      if (status.advisoryPending.length === 0 || Date.now() - gateGreenAt >= advisoryMs) {
        console.log(`${GATE_CHECK} is green on ${view.headRefOid}: merge-ready`)
        list('ADVISORY FAILED', status.advisoryFailures)
        list('ADVISORY PENDING', status.advisoryPending)
        process.exit(0)
      }
    }
    pause(intervalSeconds)
  }
  console.log(`timed out waiting on PR #${pr}`)
  process.exit(2)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main()
}
