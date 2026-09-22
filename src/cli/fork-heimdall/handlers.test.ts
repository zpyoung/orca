import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import { HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall/capability'
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

describe('orca heimdall set-concurrency handler', () => {
  it('targets the fleet owner fence and sends the new cap', async () => {
    const target = {
      watcherId: 'watcher-1',
      connectionId: null,
      pairingRevision: null
    }
    const expectedOwner = {
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceKey: 'local::/repo',
      revision: 4
    }
    const entry = {
      enrollment: {
        kind: 'objective',
        kindPayload: { workspaceKind: 'git' }
      }
    }
    callMock
      .mockResolvedValueOnce({
        id: 'status-1',
        ok: true,
        result: { capabilities: [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        id: 'fleet-1',
        ok: true,
        result: {
          generatedAtMs: 10,
          entries: [{ target, ownerFence: expectedOwner, entry }]
        }
      })
      .mockResolvedValueOnce({
        id: 'command-1',
        ok: true,
        result: { status: 'applied', appliedAtMs: 5 }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall set-concurrency'](
      context([
        ['watcher-id', 'watcher-1'],
        ['max-concurrency', '3']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, HEIMDALL_CHANNELS.fleet, {})
    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target,
      expectedOwner,
      command: { kind: 'set-concurrency', maxConcurrency: 3 }
    })
  })

  it('refuses before reading the fleet when the runtime lacks parallel execution support', async () => {
    callMock.mockResolvedValueOnce({
      id: 'status-1',
      ok: true,
      result: { capabilities: [] }
    })

    await expect(
      HEIMDALL_HANDLERS['heimdall set-concurrency'](
        context([
          ['watcher-id', 'watcher-1'],
          ['max-concurrency', '3']
        ])
      )
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('does not support live objective concurrency changes')
    })
    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith('status.get')
  })

  it('clamps a folder watcher and reports the effective cap', async () => {
    const target = { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }
    const expectedOwner = {
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceKey: 'local::/repo',
      revision: 4
    }
    callMock
      .mockResolvedValueOnce({
        id: 'status-1',
        ok: true,
        result: { capabilities: [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        id: 'fleet-1',
        ok: true,
        result: {
          generatedAtMs: 10,
          entries: [
            {
              target,
              ownerFence: expectedOwner,
              entry: { enrollment: { kind: 'objective', kindPayload: { workspaceKind: 'folder' } } }
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        id: 'command-1',
        ok: true,
        result: { status: 'applied', appliedAtMs: 5 }
      })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall set-concurrency'](
      context([
        ['watcher-id', 'watcher-1'],
        ['max-concurrency', '3']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target,
      expectedOwner,
      command: { kind: 'set-concurrency', maxConcurrency: 1 }
    })
    expect(log).toHaveBeenCalledWith('Set Heimdall watcher watcher-1 concurrency to 1.')
  })

  it.each(['0', '1.5', '1025'])('rejects an invalid cap of %s locally', async (value) => {
    await expect(
      HEIMDALL_HANDLERS['heimdall set-concurrency'](
        context([
          ['watcher-id', 'watcher-1'],
          ['max-concurrency', value]
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--max-concurrency must be a whole number from 1 to 1024'
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})
