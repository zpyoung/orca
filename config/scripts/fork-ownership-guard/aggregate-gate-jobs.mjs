/**
 * How the fork's PR workflow differs from the upstream aggregate-gate contract.
 *
 * `fork_ownership_guard` is an ungated job in `verify.needs`: it runs on every PR and is checked
 * right after `CODE_PATHS`, with no `check_job` line and no `should_run` selector. The upstream
 * aggregate tests derive their job lists from the workflow, so these helpers present them the
 * upstream-shaped lists and the fork test in this directory covers the guard itself.
 */

export const FORK_OWNERSHIP_GUARD_JOB = 'fork_ownership_guard'

const selectorVariable = (job) => `${job.replaceAll('-', '_').toUpperCase()}_SHOULD_RUN`

/** The verify job without the ungated guard, which has no selector for the generic tests to drive. */
export function aggregateJobWithoutForkGuard(verifyJob) {
  return { ...verifyJob, needs: verifyJob.needs.filter((job) => job !== FORK_OWNERSHIP_GUARD_JOB) }
}

/**
 * The classifier's jobs that this workflow reports through code_paths, plus any other needed job
 * that carries a selector (preflight's is derived from static_analysis and typecheck). The fork
 * workflow has no Windows PR job, and it gates jobs the classifier does not list.
 */
export function checkJobsForWorkflow(classifiedJobs, workflow, shell) {
  const outputs = workflow.jobs.code_paths.outputs
  const selected = classifiedJobs.filter((job) => job in outputs)
  const unlisted = workflow.jobs.verify.needs.filter(
    (job) => job !== 'preflight' && !selected.includes(job) && selectorVariable(job) in shell.env
  )
  return [...selected, ...unlisted]
}

/** The guard's `needs` entry for a plan that did not break it. */
export function forkGuardNeeds() {
  return { [FORK_OWNERSHIP_GUARD_JOB]: { result: 'success' } }
}
