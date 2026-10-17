import { describe, expect, it } from 'vitest'
import { PRECHECK_ABORTED_ERROR, runAutomationPrecheck } from './loop-precheck-runner'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

describe.skipIf(process.platform === 'win32')('runAutomationPrecheck abort', () => {
  it('kills the spawned process tree when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = runAutomationPrecheck({
      precheck: { command: 'echo $$ && exec sleep 30', timeoutSeconds: 120 },
      target: { type: 'local', cwd: process.cwd() },
      signal: controller.signal
    })

    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    const result = await pending

    const pid = Number(result.stdout.trim())
    expect(Number.isInteger(pid)).toBe(true)
    expect(result.error).toBe(PRECHECK_ABORTED_ERROR)
    expect(result.exitCode).toBeNull()
    expect(await waitUntil(() => !isAlive(pid), 3000)).toBe(true)
  })

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runAutomationPrecheck({
      precheck: { command: 'echo ran', timeoutSeconds: 5 },
      target: { type: 'local', cwd: process.cwd() },
      signal: controller.signal
    })

    expect(result.error).toBe(PRECHECK_ABORTED_ERROR)
    expect(result.stdout).toBe('')
  })

  it('runs to completion when the signal never aborts', async () => {
    const result = await runAutomationPrecheck({
      precheck: { command: 'echo ok', timeoutSeconds: 5 },
      target: { type: 'local', cwd: process.cwd() },
      signal: new AbortController().signal
    })

    expect(result).toMatchObject({ exitCode: 0, error: null, stdout: 'ok\n' })
  })
})
