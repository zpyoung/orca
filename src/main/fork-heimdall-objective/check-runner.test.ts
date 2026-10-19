import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS, runCriterionCheck } from './check-runner'

const precheckState = vi.hoisted(() => ({
  run: vi.fn()
}))

vi.mock('../automations/precheck-runner', () => ({
  runAutomationPrecheck: precheckState.run
}))

function target(args: {
  executionHostId: ObjectiveWorkspaceTarget['executionHostId']
  workspacePath: string
}): ObjectiveWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId: args.executionHostId,
    workspacePath: args.workspacePath
  }
}

function precheckResult(overrides: Record<string, unknown> = {}) {
  return {
    command: 'test -f ready',
    exitCode: 0,
    timedOut: false,
    durationMs: 47,
    stdout: 'ready\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    startedAt: 1_000,
    completedAt: 1_047,
    ...overrides
  }
}

beforeEach(() => {
  precheckState.run.mockReset()
})

describe('runCriterionCheck', () => {
  it('passes the real timeoutSeconds contract and maps actual process timing and output tails', async () => {
    const stdout = `discarded-${'x'.repeat(OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS)}`
    precheckState.run.mockResolvedValue(precheckResult({ stdout }))
    const workspace = target({
      executionHostId: 'local',
      workspacePath: '/workspace/objective'
    })

    const result = await runCriterionCheck({
      command: '  test -f ready  ',
      target: workspace,
      timeoutSeconds: 17
    })

    expect(precheckState.run).toHaveBeenCalledWith({
      precheck: { command: 'test -f ready', timeoutSeconds: 17 },
      target: { type: 'local', cwd: '/workspace/objective' }
    })
    expect(precheckState.run.mock.calls[0]?.[0].precheck).not.toHaveProperty('timeoutMs')
    expect(result).toEqual({
      command: 'test -f ready',
      pass: true,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'x'.repeat(OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS),
      stderrTail: '',
      error: null,
      startedAtMs: 1_000,
      completedAtMs: 1_047,
      durationMs: 47
    })
  })

  it('maps a timed-out process as a failed check without replacing its timing', async () => {
    precheckState.run.mockResolvedValue(
      precheckResult({
        exitCode: null,
        timedOut: true,
        error: 'Precheck timed out after 3s.',
        startedAt: 5_000,
        completedAt: 8_011,
        durationMs: 3_011
      })
    )

    const result = await runCriterionCheck({
      command: 'sleep 10',
      timeoutSeconds: 3,
      target: target({ executionHostId: 'local', workspacePath: '/repo' })
    })

    expect(result).toMatchObject({
      pass: false,
      exitCode: null,
      timedOut: true,
      error: 'Precheck timed out after 3s.',
      startedAtMs: 5_000,
      completedAtMs: 8_011,
      durationMs: 3_011
    })
  })

  it('refuses a non-local execution host without running the check', async () => {
    await expect(
      runCriterionCheck({
        command: 'true',
        target: target({ executionHostId: 'ssh:build-host', workspacePath: '/repo' })
      })
    ).rejects.toThrow('Remote criterion check target is not served by this host')
    expect(precheckState.run).not.toHaveBeenCalled()
  })
})
