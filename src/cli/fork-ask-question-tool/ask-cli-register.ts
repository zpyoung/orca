import type { RuntimeClient } from '../runtime-client'
import type { AskSpec } from '../../shared/fork-ask-question-tool/ask-question-schema'
import { callWithTransportRetry } from './ask-cli-transport-retry'
import type { AskOriginParams } from './ask-cli-flags'

export type AskRegisterParams = AskOriginParams & {
  spec: AskSpec
  requestId: string
  timeoutMs?: number
}

/** `ask.register`'s only non-id outcome (tech.md C4): no capable surface ever created the ask. */
export type AskRegisterOutcome = { askId: string } | { status: 'unavailable'; reason: string }

/**
 * Registers an ask, retrying the identical `requestId` on a bare transport failure so a lost
 * response resolves to the original `askId` (C2's idempotent upsert) instead of a second ask.
 */
export async function registerAskWithRetry(
  client: RuntimeClient,
  params: AskRegisterParams
): Promise<AskRegisterOutcome> {
  const response = await callWithTransportRetry(() =>
    client.call<AskRegisterOutcome>('ask.register', params)
  )
  return response.result
}
