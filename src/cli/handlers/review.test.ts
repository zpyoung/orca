import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { okFixture } from '../test-fixtures'
import { REVIEW_HANDLERS } from './review'

type HandlerCase = {
  key: string
  method: string
  flags?: Record<string, string>
  params: Record<string, unknown>
}

const worktree = `path:${process.platform === 'win32' ? 'C:\\repo' : '/repo'}`

const cases: HandlerCase[] = [
  { key: 'review run-create', method: 'review.runCreate', params: { worktree } },
  {
    key: 'review resolve',
    method: 'review.resolve',
    flags: {
      run: 'run-1',
      target: 'WORKTREE',
      profile: 'code-diff',
      'criteria-file': 'criteria.md'
    },
    params: {
      worktree,
      run: 'run-1',
      target: 'WORKTREE',
      profile: 'code-diff',
      criteriaFile: 'criteria.md'
    }
  },
  {
    key: 'review prepass',
    method: 'review.prepass',
    flags: { run: 'run-1' },
    params: { worktree, run: 'run-1' }
  },
  {
    key: 'review select-model',
    method: 'review.selectModel',
    flags: { run: 'run-1', 'author-family': 'anthropic', reviewer: 'codex' },
    params: { worktree, run: 'run-1', authorFamily: 'anthropic', reviewer: 'codex' }
  },
  {
    key: 'review stage-prompt',
    method: 'review.stagePrompt',
    flags: { run: 'run-1', stage: 'promote' },
    params: { worktree, run: 'run-1', stage: 'promote' }
  },
  {
    key: 'review claims',
    method: 'review.claims',
    flags: { run: 'run-1', findings: 'promote.json' },
    params: { worktree, run: 'run-1', findings: 'promote.json' }
  },
  {
    key: 'review merge',
    method: 'review.merge',
    flags: { run: 'run-1', findings: 'claims.json', judgments: 'refute.json', stage: 'refute' },
    params: {
      worktree,
      run: 'run-1',
      findings: 'claims.json',
      judgments: 'refute.json',
      stage: 'refute'
    }
  },
  {
    key: 'review gate',
    method: 'review.gate',
    flags: { run: 'run-1', depth: 'standard' },
    params: { worktree, run: 'run-1', depth: 'standard' }
  },
  {
    key: 'review manifest',
    method: 'review.manifest',
    flags: { run: 'run-1' },
    params: { worktree, run: 'run-1' }
  },
  {
    key: 'review run-abort',
    method: 'review.runAbort',
    flags: { run: 'run-1' },
    params: { worktree, run: 'run-1' }
  },
  { key: 'review run-list', method: 'review.runList', params: { worktree } },
  {
    key: 'review run-show',
    method: 'review.runShow',
    flags: { run: 'run-1' },
    params: { worktree, run: 'run-1' }
  },
  {
    key: 'review run-fail',
    method: 'review.runFail',
    flags: { run: 'run-1', reason: 'worker output was invalid' },
    params: { worktree, run: 'run-1', reason: 'worker output was invalid' }
  },
  {
    key: 'review dismiss',
    method: 'review.dismiss',
    flags: { run: 'run-1', finding: 'F1', reason: 'accepted risk' },
    params: { worktree, run: 'run-1', finding: 'F1', reason: 'accepted risk' }
  }
]

function successResult(method: string): Record<string, unknown> {
  if (method === 'review.prepass') {
    return { status: 'pass' }
  }
  if (method === 'review.selectModel') {
    return { resolved: true }
  }
  if (method === 'review.gate') {
    return { verdict: 'PASS' }
  }
  return { ok: true }
}

describe('review CLI handlers', () => {
  const originalExitCode = process.exitCode
  const callMock = vi.fn()
  const client = { call: callMock } as unknown as RuntimeClient
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  function context(flags: Record<string, string> = {}, json = true): HandlerContext {
    return {
      client,
      cwd: process.platform === 'win32' ? 'C:\\repo' : '/repo',
      flags: new Map(Object.entries(flags)),
      json,
      rawArgs: []
    }
  }

  beforeEach(() => {
    callMock
      .mockReset()
      .mockImplementation((method: string) =>
        Promise.resolve(okFixture('review', successResult(method)))
      )
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    process.exitCode = originalExitCode
  })

  it.each(cases)('brokers $key through $method', async ({ key, method, flags, params }) => {
    await REVIEW_HANDLERS[key](context(flags))

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith(method, params)
    expect(logSpy).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(0)
  })

  it.each([
    ['PASS', 0],
    ['NEEDS_FIXES', 1],
    ['CRITICAL_ISSUES', 3],
    ['NOT_REVIEWABLE', 4]
  ])('maps the %s gate verdict to exit %i', async (verdict, exitCode) => {
    callMock.mockResolvedValue(okFixture('gate', { verdict }))

    await REVIEW_HANDLERS['review gate'](context({ run: 'run-1', depth: 'deep' }))

    expect(process.exitCode).toBe(exitCode)
  })

  it.each(['fail', 'could-not-run'])('maps prepass %s to exit 1', async (status) => {
    callMock.mockResolvedValue(okFixture('prepass', { status }))

    await REVIEW_HANDLERS['review prepass'](context({ run: 'run-1' }))

    expect(process.exitCode).toBe(1)
  })

  it('maps an unresolved reviewer selection to exit 1', async () => {
    callMock.mockResolvedValue(okFixture('select', { resolved: false }))

    await REVIEW_HANDLERS['review select-model'](
      context({ run: 'run-1', 'author-family': 'anthropic' })
    )

    expect(process.exitCode).toBe(1)
  })

  it('emits a JSON error object and reserves exit 2 for RPC failures', async () => {
    callMock.mockRejectedValue(new Error('chain refused'))

    await REVIEW_HANDLERS['review manifest'](context({ run: 'run-1' }))

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { message: 'chain refused' }
    })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  it('prints non-JSON diagnostics to stderr without sacrificing the error object', async () => {
    await REVIEW_HANDLERS['review gate'](context({ run: 'run-1' }, false))

    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledOnce()
    expect(errorSpy).toHaveBeenCalledWith('Missing required --depth')
    expect(process.exitCode).toBe(2)
  })
})
