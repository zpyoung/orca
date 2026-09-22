import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readClaudeSessionOptionsFromTerminalScreen } from '../claude-terminal-session-options'
import { clearNativeChatSessionOptionCacheForTests } from '../native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from '../native-chat-pty-session-options'

describe('native chat session option report replay', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('documents that Claude reports Ultracode as xhigh in readable terminal fields', () => {
    const transcript = readFileSync(
      new URL('./__fixtures__/claude-ultracode-startup.txt', import.meta.url),
      'utf8'
    )

    expect(transcript).toContain('Sonnet 5 with xhigh effort · Claude API')
    expect(transcript).toContain('✦ ultracode · xhigh effort + dynamic workflows')
    expect(readClaudeSessionOptionsFromTerminalScreen(transcript)).toEqual({
      model: 'sonnet',
      effort: 'xhigh'
    })
  })

  it('does not replay an unchanged terminal report over a dispatched effort', async () => {
    // The Claude frame is painted at startup and repainted only on resize, so the
    // surface a later host render rebuilds reads the same launch-time effort back.
    const reportedValues = { model: 'opus', effort: 'high' }
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-report',
      mode: 'live',
      reportedValues,
      dispatchCommand: dispatch
    })!
    await surface.setOption('effort', 'max')

    const rebuilt = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-report',
      mode: 'live',
      reportedValues: { ...reportedValues },
      dispatchCommand: dispatch
    })!
    expect(rebuilt.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'max' }
    })

    // A frame that repainted after the pick is new evidence and still wins.
    rebuilt.reportSessionOptions({ model: 'opus', effort: 'low' })
    expect(rebuilt.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'low' }
    })
  })

  it('keeps an Ultracode pick pending when Claude reports xhigh for the same PTY', async () => {
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-ultracode',
      mode: 'live',
      reportedValues: { model: 'sonnet', effort: 'high' },
      dispatchCommand: dispatch
    })!

    await surface.setOption('effort', 'ultracode')
    surface.reportSessionOptions({ model: 'sonnet', effort: 'xhigh' }, Number.MAX_SAFE_INTEGER)

    expect(dispatch).toHaveBeenCalledWith('/effort ultracode')
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'dispatched',
      kind: { currentValue: 'ultracode' }
    })

    await surface.setOption('effort', 'xhigh')
    surface.reportSessionOptions({ model: 'sonnet', effort: 'xhigh' }, Number.MAX_SAFE_INTEGER)
    expect(surface.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'xhigh' }
    })

    const nextPty = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-ultracode-next',
      mode: 'live',
      reportedValues: { model: 'sonnet', effort: 'xhigh' },
      dispatchCommand: vi.fn()
    })!
    expect(nextPty.getSnapshot().find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'reported',
      kind: { currentValue: 'xhigh' }
    })
  })
})
