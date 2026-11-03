import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatSessionOptionCacheForTests } from '../../../../../shared/native-chat/input/native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from '../../../../../shared/native-chat/input/native-chat-pty-session-options'

describe('native chat session option report replay', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it('does not replay an unchanged terminal report over a dispatched effort', async () => {
    // The Claude frame is painted at startup and repainted only on resize, so the
    // surface a later host render rebuilds reads the same launch-time effort back.
    const reportedValues = { model: 'opus', effort: 'high' }
    const dispatch = vi.fn()
    const surface = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-report',
      mode: 'live',
      modelLabel: 'Model',
      reportedValues,
      dispatchCommand: dispatch
    })!
    await surface.setOption('effort', 'max')

    const rebuilt = createNativeChatPtySessionOptions({
      agent: 'claude',
      scopeKey: 'pty-report',
      mode: 'live',
      modelLabel: 'Model',
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
})
