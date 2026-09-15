import { describe, expect, it } from 'vitest'
import { ASK_LONG_POLL_SHARE, LONG_POLL_CAP } from '../runtime/runtime-rpc/runtime-rpc-long-poll'
import { ASK_WAIT_CONCURRENCY_CAP, createAskWaitConcurrencyGate } from './ask-wait-concurrency-gate'

function deferred(): {
  promise: Promise<string>
  resolve: (value: string) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ask wait concurrency gate', () => {
  it('runs concurrent waits up to the cap', async () => {
    const gate = createAskWaitConcurrencyGate(2)
    const first = deferred()
    const second = deferred()

    const running = [gate.run(() => first.promise), gate.run(() => second.promise)]
    first.resolve('a')
    second.resolve('b')

    expect(await Promise.all(running)).toEqual(['a', 'b'])
  })

  it('sheds the wait past the cap with runtime_busy', async () => {
    const gate = createAskWaitConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(() => held.promise)

    await expect(gate.run(async () => 'shed')).rejects.toThrow('runtime_busy')

    held.resolve('held')
    expect(await running).toBe('held')
  })

  it('releases the slot once a wait settles', async () => {
    const gate = createAskWaitConcurrencyGate(1)
    const held = deferred()
    const running = gate.run(() => held.promise)
    held.resolve('held')
    await running

    await expect(gate.run(async () => 'next')).resolves.toBe('next')
  })

  it('releases the slot when a wait rejects', async () => {
    const gate = createAskWaitConcurrencyGate(1)
    await expect(
      gate.run(async () => {
        throw new Error('waiter_exploded')
      })
    ).rejects.toThrow('waiter_exploded')

    await expect(gate.run(async () => 'next')).resolves.toBe('next')
  })

  it('meters each gate independently', async () => {
    const first = createAskWaitConcurrencyGate(1)
    const second = createAskWaitConcurrencyGate(1)
    const held = deferred()
    const running = first.run(() => held.promise)

    await expect(second.run(async () => 'other runtime')).resolves.toBe('other runtime')

    held.resolve('held')
    await running
  })

  it('cannot fill the long-poll budget together with orchestration asks', () => {
    const orchestrationAskCap = Math.floor(LONG_POLL_CAP * ASK_LONG_POLL_SHARE)
    expect(ASK_WAIT_CONCURRENCY_CAP + orchestrationAskCap).toBeLessThan(LONG_POLL_CAP)
  })
})
