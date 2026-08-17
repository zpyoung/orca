/** SSH pipeline checkpoint backend: calls the relay's narrow checkpoint RPCs, never `SshGitProvider.exec`. */

import type { SshGitProvider } from '../../providers/ssh-git-provider'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'

export function createSshCheckpointBackend(provider: SshGitProvider): PipelineCheckpointBackend {
  return {
    capture: (args) => provider.pipelineCheckpointCapture(args),
    restore: (args) => provider.pipelineCheckpointRestore(args)
  }
}
