import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'

export type RuntimeEnvironmentDiagnosticsEvent = {
  environmentId: string
  transportGeneration: number
  diagnostics: RemoteRuntimeSharedConnectionDiagnostics
}

export type RuntimeEnvironmentDiagnosticsPublisher = (
  event: RuntimeEnvironmentDiagnosticsEvent
) => void

const ignoreRuntimeEnvironmentDiagnostics: RuntimeEnvironmentDiagnosticsPublisher = () => {}
let currentPublisher = ignoreRuntimeEnvironmentDiagnostics

export function setRuntimeEnvironmentDiagnosticsPublisher(
  publisher: RuntimeEnvironmentDiagnosticsPublisher | null
): void {
  currentPublisher = publisher ?? ignoreRuntimeEnvironmentDiagnostics
}

export function publishRuntimeEnvironmentDiagnostics(
  event: RuntimeEnvironmentDiagnosticsEvent
): void {
  currentPublisher(event)
}
