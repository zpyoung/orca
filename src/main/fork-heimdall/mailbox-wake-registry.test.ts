import { afterEach, describe, expect, it } from 'vitest'
import {
  heimdallMailboxAddressForDispatch,
  heimdallMailboxAddressForRun,
  notifyHeimdallMailboxArrival,
  setHeimdallMailboxWake
} from './mailbox-wake-registry'

afterEach(() => {
  setHeimdallMailboxWake(null)
})

describe('heimdall mailbox wake registry', () => {
  it('stays inert when no kernel has installed a wake', () => {
    expect(() => notifyHeimdallMailboxArrival('run:absent', 'worker_done')).not.toThrow()
    expect(() => notifyHeimdallMailboxArrival('run:absent')).not.toThrow()
  })

  it('wakes on the message types that change a decision and ignores liveness traffic', () => {
    const woken: string[] = []
    setHeimdallMailboxWake((address) => woken.push(address))
    const address = heimdallMailboxAddressForRun('run_abc123')

    notifyHeimdallMailboxArrival(address, 'worker_done')
    notifyHeimdallMailboxArrival(address, 'question')
    notifyHeimdallMailboxArrival(address, 'escalation')
    notifyHeimdallMailboxArrival(address, 'heartbeat')
    notifyHeimdallMailboxArrival(address, 'status')

    expect(woken).toEqual([address, address, address])
  })

  it('builds a dispatch-scoped address distinct from a run address', () => {
    expect(heimdallMailboxAddressForDispatch('dispatch-1')).toBe('dispatch:dispatch-1')
    expect(heimdallMailboxAddressForDispatch('dispatch-1')).not.toBe(
      heimdallMailboxAddressForRun('dispatch-1')
    )
  })

  it('wakes on an unnamed message type rather than dropping it', () => {
    const woken: string[] = []
    setHeimdallMailboxWake((address) => woken.push(address))

    notifyHeimdallMailboxArrival('run:run_abc123')

    expect(woken).toEqual(['run:run_abc123'])
  })

  it('never lets a failing wake escape into the send that triggered it', () => {
    setHeimdallMailboxWake(() => {
      throw new Error('kernel exploded')
    })

    expect(() => notifyHeimdallMailboxArrival('run:run_abc123', 'worker_done')).not.toThrow()
  })
})
