import type {
  WatcherCommandRequest,
  WatcherCommandResult
} from '../../shared/fork-heimdall/fleet-types'
import type {
  FleetEnvironmentIdentity,
  FleetEnvironmentTransport
} from './fleet-environment-transport'
import type { RemoteFleetMirrorState } from './fleet-remote-mirror-state'
import { OWNER_UNREACHABLE, refused, sendRemoteWatcherCommand } from './fleet-remote-operations'

/** Negotiates command capabilities before crossing the owner transport boundary. */
export function commandRemoteWatcher(
  environments: FleetEnvironmentTransport,
  mirror: RemoteFleetMirrorState | undefined,
  request: WatcherCommandRequest,
  onChanged: () => void
): Promise<WatcherCommandResult> {
  const identity: FleetEnvironmentIdentity = {
    id: request.target.connectionId!,
    pairingRevision: request.target.pairingRevision!
  }
  if (!mirror || mirror.identity.pairingRevision !== identity.pairingRevision) {
    return Promise.resolve(
      refused('owner-conflict', 'The runtime environment pairing changed; refresh and try again.')
    )
  }
  const availability = environments.availability(identity)
  if (availability === 'replaced') {
    return Promise.resolve(
      refused('owner-conflict', 'The runtime environment pairing changed; refresh and try again.')
    )
  }
  if (!mirror.reachable || availability !== 'available') {
    return Promise.resolve(refused('owner-unreachable', OWNER_UNREACHABLE))
  }
  if (mirror.commandSupport !== 'supported') {
    return Promise.resolve(
      refused(
        'unsupported-capability',
        mirror.commandSupport === 'unsupported'
          ? 'The owning runtime does not support Heimdall commands. Update the host and try again.'
          : 'Heimdall command support could not be verified. Refresh the owner state and try again.'
      )
    )
  }
  if (
    request.command.kind === 'set-concurrency' &&
    mirror.parallelExecutionSupport !== 'supported'
  ) {
    return Promise.resolve(
      refused(
        'unsupported-capability',
        mirror.parallelExecutionSupport === 'unsupported'
          ? 'The owning runtime does not support live objective concurrency changes. Update the host and try again.'
          : 'Parallel objective execution support could not be verified. Refresh the owner state and try again.'
      )
    )
  }
  if (request.command.kind === 'delete' && mirror.deleteSupport !== 'supported') {
    return Promise.resolve(
      refused(
        'unsupported-capability',
        mirror.deleteSupport === 'unsupported'
          ? 'The owning runtime does not support permanent watcher deletion. Update the host and try again.'
          : 'Permanent watcher deletion support could not be verified. Refresh the owner state and try again.'
      )
    )
  }
  if (
    request.command.kind === 'answer-escalation' &&
    mirror.answerEscalationSupport !== 'supported'
  ) {
    return Promise.resolve(
      refused(
        'unsupported-capability',
        mirror.answerEscalationSupport === 'unsupported'
          ? 'The owning runtime does not support answering an owner escalation. Update the host and try again.'
          : 'Owner escalation answer support could not be verified. Refresh the owner state and try again.'
      )
    )
  }
  return sendRemoteWatcherCommand(environments, identity, request, () => {
    if (request.command.kind === 'set-concurrency') {
      mirror.parallelExecutionSupport = 'unsupported'
      onChanged()
      return
    }
    if (request.command.kind === 'delete') {
      mirror.deleteSupport = 'unsupported'
    } else if (request.command.kind === 'answer-escalation') {
      mirror.answerEscalationSupport = 'unsupported'
    } else {
      mirror.commandSupport = 'unsupported'
    }
    onChanged()
  })
}
