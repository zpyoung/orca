import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  effectiveAllowedFlags,
  findCommandSpec,
  isCommandGroup,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from '../args'
import { dispatch, HANDLER_COMMAND_KEYS, type HandlerContext } from '../dispatch'
import { COMMAND_SPECS } from '../specs'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => [spec.path, ...(spec.aliases ?? [])])

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca heimdall CLI registration', () => {
  it('normalizes the watcher id positional and accepts output flags', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'debug', 'watcher-1', '--out', 'report.json', '--json'], COMMAND_PATHS)
    )

    expect(parsed.commandPath).toEqual(['heimdall', 'debug'])
    expect(parsed.flags.get('watcher-id')).toBe('watcher-1')
    expect(parsed.flags.get('out')).toBe('report.json')
    expect(parsed.flags.get('json')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('normalizes the set-concurrency positionals', () => {
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'set-concurrency', 'watcher-1', '3', '--json'], COMMAND_PATHS)
    )

    expect(parsed.commandPath).toEqual(['heimdall', 'set-concurrency'])
    expect(parsed.flags.get('watcher-id')).toBe('watcher-1')
    expect(parsed.flags.get('max-concurrency')).toBe('3')
    expect(parsed.flags.get('json')).toBe(true)
    expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed)).not.toThrow()
  })

  it('registers Heimdall and both live leaves in the command registries', () => {
    const debugSpec = findCommandSpec(COMMAND_SPECS, ['heimdall', 'debug'])
    if (!debugSpec) {
      throw new Error('Missing heimdall debug spec')
    }

    expect(isCommandGroup(COMMAND_SPECS, ['heimdall'])).toBe(true)
    expect(HANDLER_COMMAND_KEYS.has('heimdall debug')).toBe(true)
    expect(HANDLER_COMMAND_KEYS.has('heimdall set-concurrency')).toBe(true)
    expect(effectiveAllowedFlags(debugSpec)).not.toContain('page')
  })

  it('dispatches the normalized command to the local-kernel debug endpoint', async () => {
    const callMock = vi.fn().mockResolvedValue({
      id: 'request-1',
      ok: true,
      result: { schemaVersion: 2 }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const parsed = normalizeCommandPositionals(
      COMMAND_SPECS,
      parseArgs(['heimdall', 'debug', 'watcher-1'], COMMAND_PATHS)
    )
    const context: HandlerContext = {
      flags: parsed.flags,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch under test calls only client.call; RuntimeClient's other members are unused.
      client: { call: callMock } as unknown as HandlerContext['client'],
      cwd: '/repo',
      json: false
    }

    await dispatch(parsed.commandPath, context)

    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.debugReport, {
      watcherId: 'watcher-1',
      connectionId: null,
      pairingRevision: null
    })
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ schemaVersion: 2 }, null, 2))
  })
})
