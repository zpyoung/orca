const HEIMDALL_SUBSCRIBE_METHOD = 'heimdall:subscribe'
const HEIMDALL_UNSUBSCRIBE_METHOD = 'heimdall:unsubscribe'

export function getHeimdallSubscriptionCleanupRequest(subscription: {
  method: string
  remoteSubscriptionId?: string | null
}): { method: string; params: unknown } | null {
  if (subscription.method !== HEIMDALL_SUBSCRIBE_METHOD || !subscription.remoteSubscriptionId) {
    return null
  }
  return {
    method: HEIMDALL_UNSUBSCRIBE_METHOD,
    params: { subscriptionId: subscription.remoteSubscriptionId }
  }
}
