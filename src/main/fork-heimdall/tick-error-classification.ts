import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'

/**
 * True only for errors that positively signal lost contact with the execution host: a dropped SSH
 * link or provider, or a remote runtime transport failure. Anything else — including an unknown
 * error — is a local failure, so a deterministic bug is never reported as an unreachable host.
 */
export function isExecutionHostContactLoss(error: unknown): boolean {
  if (isSshRequestOutcomeUnverifiable(error)) {
    return true
  }
  if (error instanceof SshHostNotServedError) {
    return true
  }
  return error instanceof Error
    ? isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
    : false
}
