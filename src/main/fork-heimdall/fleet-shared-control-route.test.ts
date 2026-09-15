import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_COMMANDS_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall/capability'
import { RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'
import { createSharedControlSubscription } from '../../shared/remote-runtime-shared-control-subscriptions'
import { getCleanupRequest } from '../../shared/remote-runtime-shared-control-protocol'
import { shouldRouteSubscriptionBySupport } from '../ipc/runtime-environment-support-routing'

describe('Heimdall remote shared-control route', () => {
  it('advertises mutations without changing the runtime protocol version', () => {
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
  })

  it('keeps fleet publication on the reconnecting shared-control subscription path', () => {
    expect(shouldRouteSubscriptionBySupport('heimdall:subscribe')).toBe(true)
  })

  it('releases the host subscription when a logical mirror closes', () => {
    const subscription = createSharedControlSubscription({
      requestId: 'client-subscription',
      method: 'heimdall:subscribe',
      params: {},
      retainedParamsBytes: 2,
      callbacks: { onResponse: vi.fn(), onError: vi.fn() }
    })
    subscription.remoteSubscriptionId = 'host-subscription'

    expect(getCleanupRequest(subscription)).toEqual({
      method: 'heimdall:unsubscribe',
      params: { subscriptionId: 'host-subscription' }
    })
  })
})
