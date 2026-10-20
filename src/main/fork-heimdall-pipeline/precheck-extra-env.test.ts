import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from '../automations/precheck-runner'

vi.mock('../ipc/ssh', () => ({
  getSshConnectionManager: () => null
}))

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

describe('runAutomationPrecheck extraEnv', () => {
  let cwd = ''

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-precheck-extra-env-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('merges local extra environment variables over the inherited environment', async () => {
    const inheritedPath = process.env.PATH ?? ''
    const withoutExtraEnv = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          `process.stdout.write(process.env.PATH === ${JSON.stringify(inheritedPath)} ? 'inherited' : 'missing')`
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd }
    })
    const withExtraEnv = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          `process.stdout.write([process.env.PR_TITLE, process.env.PATH === ${JSON.stringify(inheritedPath)} ? 'inherited' : 'missing'].join(':'))`
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd, extraEnv: { PR_TITLE: 'hello' } }
    })

    expect(withoutExtraEnv.stdout).toBe('inherited')
    expect(withExtraEnv.stdout).toBe('hello:inherited')
  })
})
