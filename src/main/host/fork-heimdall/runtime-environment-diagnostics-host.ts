import { setRuntimeEnvironmentDiagnosticsPublisher } from '../../fork-heimdall/runtime-environment-diagnostics-port'
import { publishRuntimeEnvironmentDiagnostics } from '../../ipc/runtime-environments/runtime-environment-diagnostics-broadcast'

export function installRuntimeEnvironmentDiagnosticsHost(): void {
  setRuntimeEnvironmentDiagnosticsPublisher(publishRuntimeEnvironmentDiagnostics)
}
