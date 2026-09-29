import {
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE,
  HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
} from '../../shared/fork-heimdall/capability'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallCommandSupport } from './fleet-projection'

/** Strips `roleLaunch` from an objective enrollment when the remote host has not negotiated it. */
export function enrollmentWithoutUnsupportedRoleLaunch(
  input: EnrollInput,
  roleLaunchSupported: boolean
): EnrollInput {
  if (
    roleLaunchSupported ||
    input.kind !== 'objective' ||
    typeof input.kindPayload !== 'object' ||
    input.kindPayload === null ||
    Array.isArray(input.kindPayload)
  ) {
    return input
  }
  if (!('roleLaunch' in input.kindPayload)) {
    return input
  }
  const { roleLaunch: _roleLaunch, ...legacyKindPayload } = input.kindPayload
  return { ...input, kindPayload: legacyKindPayload }
}

/** Only explicit `required` can degrade to a legacy host; missing scope means `all`. */
export function enrollmentForMergeCheckScopeCompatibility(
  input: EnrollInput,
  mergeCheckScopeSupport: HeimdallCommandSupport
): EnrollInput {
  const mergeCheckScopeSupported = mergeCheckScopeSupport === 'supported'
  if (
    typeof input.kindPayload !== 'object' ||
    input.kindPayload === null ||
    Array.isArray(input.kindPayload)
  ) {
    return input
  }

  if (input.kind === 'objective') {
    const landingBar = 'landingBar' in input.kindPayload ? input.kindPayload.landingBar : undefined
    const handoffNeedsHostedReview = landingBar === 'hosted-review' || landingBar === 'merged'
    if (!mergeCheckScopeSupported && handoffNeedsHostedReview) {
      throw new Error(HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE)
    }
    return input
  }

  if (input.kind !== 'hosted-review' || mergeCheckScopeSupported) {
    return input
  }
  if (
    !('mergeCheckScope' in input.kindPayload) ||
    input.kindPayload.mergeCheckScope !== 'required'
  ) {
    throw new Error(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE)
  }
  // stripping for a host that may be current would let its `all` default override the choice
  if (mergeCheckScopeSupport === 'unknown') {
    return input
  }

  const { mergeCheckScope: _mergeCheckScope, ...legacyKindPayload } = input.kindPayload
  return { ...input, kindPayload: legacyKindPayload }
}
