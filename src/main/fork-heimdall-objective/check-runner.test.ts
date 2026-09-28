import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS, runCriterionCheck } from './check-runner'

const precheckState = vi.hoisted(() => ({
  run: vi.fn(),
  sshState: vi.fn(),
  sshTargetId: vi.fn()
}))

vi.mock('../automations/precheck-runner', () => ({
  runAutomationPrecheck: precheckState.run
}))

vi.mock('../runtime/runtime-file-command-target', () => ({
  runtimeFileSshTargetId: precheckState.sshTargetId
}))

vi.mock('../ssh/ssh-target-registry', () => ({
  getRegisteredSshState: precheckState.sshState
}))

function target(args: {
  executionHostId: ObjectiveWorkspaceTarget['executionHostId']
  workspacePath: string
  provider: IFilesystemProvider | null
}): ObjectiveWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId: args.executionHostId,
    workspacePath: args.workspacePath,
    fileProvider: args.provider
  }
}

function stubProvider(): IFilesystemProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque marker only; runCriterionCheck branches on presence/null, never calls provider methods.
  return {} as IFilesystemProvider
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
  precheckState.sshState.mockReset()
  precheckState.sshTargetId.mockReset()
})

describe('runCriterionCheck', () => {
  it('passes the real timeoutSeconds contract and maps actual process timing and output tails', async () => {
    const stdout = `discarded-${'x'.repeat(OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS)}`
    precheckState.sshTargetId.mockReturnValue(undefined)
    precheckState.run.mockResolvedValue(precheckResult({ stdout }))
    const workspace = target({
      executionHostId: 'local',
      workspacePath: '/workspace/objective',
      provider: null
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

  it('routes a POSIX provider-backed execution host to its exact SSH target', async () => {
    const provider = stubProvider()
    precheckState.sshTargetId.mockReturnValue('build-host')
    precheckState.sshState.mockReturnValue({ remotePlatform: 'linux' })
    precheckState.run.mockResolvedValue(
      precheckResult({ exitCode: 9, stderr: 'check failed', completedAt: 1_052, durationMs: 52 })
    )
    const workspace = target({
      executionHostId: 'ssh:build-host',
      workspacePath: '/srv/repo',
      provider
    })

    const result = await runCriterionCheck({ command: 'test -f ready', target: workspace })

    expect(precheckState.sshTargetId).toHaveBeenCalledWith(workspace)
    expect(precheckState.run).toHaveBeenCalledWith({
      precheck: { command: 'test -f ready', timeoutSeconds: 300 },
      target: { type: 'ssh', cwd: '/srv/repo', connectionId: 'build-host' }
    })
    expect(result.pass).toBe(false)
    expect(result.exitCode).toBe(9)
    expect(result.stderrTail).toBe('check failed')
    expect(precheckState.sshState).toHaveBeenCalledWith('build-host')
  })

  it('fails closed without executing a POSIX-wrapped check on a Windows SSH host', async () => {
    const provider = stubProvider()
    precheckState.sshTargetId.mockReturnValue('windows-host')
    precheckState.sshState.mockReturnValue({ remotePlatform: 'win32' })

    const result = await runCriterionCheck({
      command: 'npm test',
      target: target({
        executionHostId: 'ssh:windows-host',
        workspacePath: 'C:\\work\\objective',
        provider
      })
    })

    expect(precheckState.sshState).toHaveBeenCalledWith('windows-host')
    expect(precheckState.run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      command: 'npm test',
      pass: false,
      exitCode: null,
      timedOut: false,
      stdoutTail: '',
      stderrTail: '',
      error: 'Criterion check preflight does not support the Windows SSH command dialect.'
    })
  })

  it('fails closed when the SSH command dialect is unavailable', async () => {
    const provider = stubProvider()
    precheckState.sshTargetId.mockReturnValue('unknown-host')
    precheckState.sshState.mockReturnValue({ status: 'connected' })

    const result = await runCriterionCheck({
      command: 'true',
      target: target({
        executionHostId: 'ssh:unknown-host',
        workspacePath: '/srv/objective',
        provider
      })
    })

    expect(precheckState.run).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      pass: false,
      exitCode: null,
      timedOut: false,
      error:
        'Criterion check preflight cannot select an SSH command dialect because the host platform is unavailable.'
    })
  })

  it('maps a timed-out process as a failed check without replacing its timing', async () => {
    precheckState.sshTargetId.mockReturnValue(undefined)
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
      target: target({ executionHostId: 'local', workspacePath: '/repo', provider: null })
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

  it('fails closed when a provider-backed target has no SSH route', async () => {
    precheckState.sshTargetId.mockReturnValue(undefined)
    const provider = stubProvider()

    await expect(
      runCriterionCheck({
        command: 'true',
        target: target({ executionHostId: 'runtime:remote', workspacePath: '/repo', provider })
      })
    ).rejects.toThrow('not SSH-routable')
    expect(precheckState.run).not.toHaveBeenCalled()
  })
})
