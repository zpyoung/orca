import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import type { HandlerContext } from '../dispatch'
import { HEIMDALL_HANDLERS } from './handlers'

const callMock = vi.fn()
const temporaryDirectories: string[] = []

function context(
  flags: [string, string | boolean][],
  overrides: { cwd?: string; json?: boolean } = {}
): HandlerContext {
  return {
    flags: new Map(flags),
    client: { call: callMock } as unknown as HandlerContext['client'],
    cwd: overrides.cwd ?? '/repo',
    json: overrides.json ?? false
  }
}

beforeEach(() => {
  callMock.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('orca heimdall debug handler', () => {
  it('rejects a missing watcher id before contacting the runtime', async () => {
    await expect(HEIMDALL_HANDLERS['heimdall debug'](context([]))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Missing required --watcher-id'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([false, true])('prints the bare report JSON when json mode is %s', async (json) => {
    const report = { schemaVersion: 2, watcher: { id: 'watcher-1' } }
    callMock.mockResolvedValue({ id: 'request-1', ok: true, result: report })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall debug'](context([['watcher-id', 'watcher-1']], { json }))

    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.debugReport, {
      watcherId: 'watcher-1',
      connectionId: null,
      pairingRevision: null
    })
    expect(logSpy).toHaveBeenCalledOnce()
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(report, null, 2))
  })

  it('writes the bare report JSON to a cwd-relative output path without printing it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-heimdall-debug-'))
    temporaryDirectories.push(cwd)
    const report = { schemaVersion: 2, pointers: [{ role: 'workspace', path: '/repo' }] }
    callMock.mockResolvedValue({ id: 'request-2', ok: true, result: report })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall debug'](
      context(
        [
          ['watcher-id', 'watcher-2'],
          ['out', 'report.json']
        ],
        { cwd }
      )
    )

    expect(await readFile(join(cwd, 'report.json'), 'utf8')).toBe(
      `${JSON.stringify(report, null, 2)}\n`
    )
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('rejects --out without a path before contacting the runtime', async () => {
    await expect(
      HEIMDALL_HANDLERS['heimdall debug'](
        context([
          ['watcher-id', 'watcher-1'],
          ['out', true]
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--out requires a value; it was passed with none.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})
