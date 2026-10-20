import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupTemporaryDirectories,
  createLocalFolderTarget
} from '../fork-heimdall-objective/objective-temp-workspace-test-fixtures'
import { runCheckNode } from './check-node-executor'

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

describe('runCheckNode', () => {
  it('maps zero and nonzero process exit codes to pass and failure', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-check-node-')
    const passed = await runCheckNode({
      command: nodeCommand("process.stdout.write('ready')"),
      timeoutSeconds: 5,
      target
    })
    const failed = await runCheckNode({
      command: nodeCommand("process.stdout.write('failed'); process.exitCode = 3"),
      timeoutSeconds: 5,
      target
    })

    expect(passed).toMatchObject({
      exitCode: 0,
      passed: true,
      outputTail: 'ready',
      timedOut: false
    })
    expect(failed).toMatchObject({
      exitCode: 3,
      passed: false,
      outputTail: 'failed',
      timedOut: false
    })
  })

  it('reports a process timeout and its bounded combined output tail', async () => {
    const target = await createLocalFolderTarget(temporaryDirectories, 'orca-check-node-')
    // A real child process is required to verify the precheck timeout and process-tree kill.
    const timedOut = await runCheckNode({
      command: nodeCommand("process.stdout.write('started'); setTimeout(() => {}, 5000)"),
      timeoutSeconds: 1,
      target
    })
    const tailed = await runCheckNode({
      command: nodeCommand(
        "process.stdout.write('x'.repeat(5000)); process.stderr.write('y'.repeat(5000) + 'finished')"
      ),
      timeoutSeconds: 5,
      target
    })

    expect(timedOut).toMatchObject({ exitCode: null, passed: false, timedOut: true })
    expect(timedOut.outputTail).toContain('started')
    expect(tailed.outputTail).toHaveLength(4096)
    expect(tailed.outputTail.endsWith('finished')).toBe(true)
  })
})
