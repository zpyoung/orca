/** SSH pipeline checkpoint backend (tech §3.7, §4.6): calls the relay's narrow checkpoint RPCs, never `SshGitProvider.exec`. */

import type { SshGitProvider } from '../../providers/ssh-git-provider'
import type { PipelineCheckpointBackend } from './pipeline-checkpoint'

export function createSshCheckpointBackend(provider: SshGitProvider): PipelineCheckpointBackend {
  return {
    capture: (args) => provider.pipelineCheckpointCapture(args),
    restore: (args) => provider.pipelineCheckpointRestore(args)
  }
}
