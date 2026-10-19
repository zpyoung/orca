import type { OrcaRuntimeService } from '../orca-runtime'
import { captureStructuredAgentCliSource } from '../../native-chat/structured-agent-cli-source'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import { isRegistrationFencedUnsubscribe, type RpcContext, type RpcRequest } from './core'
import { resolveRpcCallerIdentity } from './rpc-caller-identity'
import type { RpcCallerScope } from './rpc-caller-scope'

export type RpcDispatchStreamingOptions = Pick<
  RpcContext,
  | 'authenticatedCallerFingerprint'
  | 'connectionId'
  | 'signal'
  | 'clientId'
  | 'pairedDeviceId'
  | 'pairedDeviceParentId'
  | 'caller'
  | 'clientKind'
  | 'clientCapabilities'
  | 'updateClientCapabilities'
  | 'pairing'
  | 'deviceSelf'
  | 'mobileRelayHosts'
  | 'delegatedMobileDevices'
  | 'sendBinary'
  | 'registerBinaryStreamHandler'
  | 'registerBinaryMessageHandler'
> & {
  /** What the transport proved the caller may do; absent means this host's owner. */
  callerScope?: RpcCallerScope
  clientKind?: 'mobile' | 'runtime'
  clientCapabilities?: readonly RuntimeCapability[]
  authenticatedCredential?: string
  updateClientCapabilities?: (capabilities: readonly RuntimeCapability[]) => void
  pairing?: PairingRpcContext
  sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  registerBinaryStreamHandler?: (
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ) => () => void
  registerBinaryMessageHandler?: (
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ) => () => void
}
