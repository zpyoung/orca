import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupTemporaryDirectories,
  createLocalFolderTarget
} from '../fork-heimdall-objective/objective-temp-workspace-test-fixtures'
import { runCriterionCheck } from '../fork-heimdall-objective/check-runner'
import { runAutomationPrecheck } from '../automations/precheck-runner'
import { ScriptEnvRejectedError, posixEnvExportPrefix, runScriptNode } from './script-node-executor'

vi.mock('../runtime/runtime-file-command-target', () => ({
  runtimeFileSshTargetId: () => undefined
}))

vi.mock('../ssh/ssh-target-registry', () => ({
  getRegisteredSshState: () => undefined
}))

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: () => null
}))

const temporaryDirectories: string[] = []

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

describe('script-node-executor', () => {
  it('delivers quoted environment values to a real local process', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-node-')
    const env = { SCRIPT_TITLE: "it's $ready\nnext" }
    const script = 'process.stdout.write(JSON.stringify(process.env.SCRIPT_TITLE))'
    const command = `  ${nodeCommand(script)}\n`

    const actual = await runScriptNode({ command, env, timeoutSeconds: 5, target })

    expect(actual).toMatchObject({
      exitCode: 0,
      passed: true,
      stdout: { text: JSON.stringify(env.SCRIPT_TITLE), truncated: false },
      timedOut: false,
      error: null
    })
  })

  it('executes POSIX exports with literal apostrophe, newline, and dollar values', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-prefix-')
    const env = { B: "it's", A: 'x$y\nz' }
    const script = 'process.stdout.write(JSON.stringify([process.env.A, process.env.B]))'
    const command = `${posixEnvExportPrefix(env)} ${nodeCommand(script)}`
    const result = await runAutomationPrecheck({
      precheck: { command, timeoutSeconds: 5 },
      target: { type: 'local', cwd: target.workspacePath }
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(JSON.stringify([env.A, env.B]))
  })

  it('preserves process exit codes and caps a truncated stdout tail', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-output-')
    const command = nodeCommand(
      [
        "process.stdout.write('x'.repeat(5000) + 'last-output')",
        "process.stderr.write('script-error')",
        'process.exitCode = 3'
      ].join('; ')
    )
    const actual = await runScriptNode({ command, env: {}, timeoutSeconds: 5, target })

    expect(actual.exitCode).toBe(3)
    expect(actual.passed).toBe(false)
    expect(actual.stdout.text.length).toBeLessThanOrEqual(4096)
    expect(actual.stdout.text.endsWith('last-output')).toBe(true)
    expect(actual.stderrTail).toBe('script-error')
    expect(actual.stdout.truncated).toBe(true)
  })

  it('reports a timeout from the real local process runner', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-timeout-')
    // A real child process is required to verify the timeout and process-tree kill.
    const actual = await runScriptNode({
      command: nodeCommand('setTimeout(() => {}, 5000)'),
      env: {},
      timeoutSeconds: 1,
      target
    })

    expect(actual).toMatchObject({
      exitCode: null,
      passed: false,
      timedOut: true,
      error: 'Precheck timed out after 1s.'
    })
  })

  it('rejects denied and invalid environment names before execution', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-denied-')

    await expect(
      runScriptNode({ command: 'true', env: { PATH: '/tmp' }, timeoutSeconds: 5, target })
    ).rejects.toBeInstanceOf(ScriptEnvRejectedError)
    await expect(
      runScriptNode({ command: 'true', env: { lowercase: 'value' }, timeoutSeconds: 5, target })
    ).rejects.toBeInstanceOf(ScriptEnvRejectedError)
  })

  it('keeps a pipeline command byte-for-byte when executing it', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-script-command-')
    const command = `  ${nodeCommand("process.stdout.write('command')")}\n`
    const result = await runCriterionCheck({
      command,
      target,
      timeoutSeconds: 5,
      preserveCommand: true
    })

    expect(result.command).toBe(command)
    expect(result.stdoutTail).toBe('command')
  })
})
