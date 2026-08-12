/**
 * The `bugfix-fast` starter written into `~/.orca/pipelines/` on first use of the Pipelines
 * feature (never overwriting an existing file of that name). Verbatim from the logic spec's
 * worked example. Defined here (not in `src/main/pipelines/pipeline-starter-template.ts`,
 * which re-exports it) so shared-layer tests can assert the round-trip without a src/shared
 * -> src/main import.
 */
export const BUGFIX_FAST_STARTER_TEMPLATE = `# ~/.orca/pipelines/bugfix-fast.yaml
version: 1
name: bugfix-fast
description: Reproduce a bug, fix it, prove the fix, open a PR. No human gates.

defaults:
  harness: claude
  model: sonnet
  effort: medium
  onFailure:
    retries: 1
  limits:
    maxMinutes: 20

nodes:
  - id: repro
    title: Reproduce
    prompt: |
      Reproduce the bug described below. Produce a minimal, repeatable
      reproduction — a failing test where the repo has a test suite, otherwise
      a script — and commit it with a message starting "repro:".

      Bug report:
      {{input}}

  - id: fix
    title: Fix
    needs: [repro]
    prompt: |
      Fix the bug. The reproduction from the previous node is committed in the
      working tree. Keep the change minimal and focused; do not refactor
      unrelated code. Commit the fix.

  - id: test
    title: Verify
    needs: [fix]
    onFailure:
      retries: 2
    prompt: |
      Run the reproduction and the project's test suite. If anything fails,
      repair the fix until the reproduction passes and the suite is green.
      Commit any changes.

  - id: pr
    title: Open PR
    needs: [test]
    limits:
      maxMinutes: 10
    prompt: |
      Push the branch and open a pull/merge request using the repository's
      provider tooling (gh, glab, or equivalent). Summarize the bug, the
      reproduction, and the fix in the description.
`
