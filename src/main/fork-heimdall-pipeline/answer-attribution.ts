import * as os from 'node:os'
import type { WatcherCommandRequest } from '../../shared/fork-heimdall/fleet-types'
import {
  isLocalArtifactPasswordCaller,
  type ArtifactPasswordCaller
} from '../runtime/rpc/methods/fork-artifact-passwords/artifact-password-local-caller'

/** Stamps pipeline-choice answers on first-hop requests, but not forwarded runtime requests. */
export function stampPipelineAnswerAttribution(
  request: WatcherCommandRequest,
  caller: ArtifactPasswordCaller,
  nowMs: number
): WatcherCommandRequest {
  if (
    (caller.clientKind === 'runtime' && !isLocalArtifactPasswordCaller(caller)) ||
    request.command.kind !== 'answer-pipeline-choice' ||
    request.command.attribution !== undefined
  ) {
    return request
  }
  return {
    ...request,
    command: {
      ...request.command,
      attribution: {
        actor: { user: os.userInfo().username, host: os.hostname() },
        surface: request.command.surface ?? 'heimdall-detail',
        atMs: nowMs
      }
    }
  }
}
