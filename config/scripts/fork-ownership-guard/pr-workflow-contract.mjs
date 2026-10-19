import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { PR_CHECK_JOBS as CLASSIFIED_PR_CHECK_JOBS } from '../pr-code-change-scope.mjs'
import { aggregateJobWithoutForkGuard, checkJobsForWorkflow } from './aggregate-gate-jobs.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const aggregateShell = workflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)

/** The classifier's jobs as the fork's PR workflow reports them. */
export const PR_CHECK_JOBS = checkJobsForWorkflow(
  CLASSIFIED_PR_CHECK_JOBS,
  workflow,
  aggregateShell
)

/** The workflow as upstream's contract tests expect it: `verify` needs only the gated jobs. */
export function workflowWithoutForkGuard(source) {
  return {
    ...source,
    jobs: { ...source.jobs, verify: aggregateJobWithoutForkGuard(source.jobs.verify) }
  }
}
