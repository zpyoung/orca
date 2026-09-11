import type { LedgerRequest, LedgerResponse } from '../../../shared/ledger'
import {
  ledgerUiAttestationPayload,
  type LedgerUiAttestation
} from '../../../shared/ledger-ui-attestation'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

type RuntimeEnvelope = {
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string; data?: unknown }
}
type WebLedgerApiOptions = {
  selectEnvironment: (environmentId?: string) => StoredWebRuntimeEnvironment
  call: (
    environment: StoredWebRuntimeEnvironment,
    method: string,
    params: unknown
  ) => Promise<RuntimeEnvelope>
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function createAttestation(
  request: LedgerRequest,
  deviceToken: string
): Promise<LedgerUiAttestation> {
  const timestamp = Date.now()
  const nonceBytes = new Uint8Array(18)
  crypto.getRandomValues(nonceBytes)
  const nonce = encodeBase64Url(nonceBytes)
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(deviceToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(ledgerUiAttestationPayload(request, timestamp, nonce))
  )
  return { timestamp, nonce, mac: encodeBase64Url(new Uint8Array(signature)) }
}

function throwLedgerError(response: RuntimeEnvelope): never {
  const error = new Error(response.error?.message ?? 'Ledger request failed') as Error & {
    code?: string
    details?: unknown
  }
  error.code = response.error?.code
  error.details = response.error?.data
  throw error
}

export function createWebLedgerApi(options: WebLedgerApiOptions) {
  return {
    request: async (request: LedgerRequest, environmentId?: string): Promise<LedgerResponse> => {
      const environment = options.selectEnvironment(environmentId)
      const endpoint =
        environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
        environment.endpoints[0]
      if (!endpoint) {
        throw new Error('No runtime endpoint is stored for this web client.')
      }
      const status = await options.call(environment, 'status.get', undefined)
      const capabilities = (status.result as { capabilities?: unknown } | undefined)?.capabilities
      if (!status.ok || !Array.isArray(capabilities) || !capabilities.includes('ledger.v1')) {
        throw new Error('Selected runtime does not support ledger.v1')
      }
      const response = await options.call(environment, 'ledger.ui', {
        request,
        attestation: await createAttestation(request, endpoint.deviceToken)
      })
      if (!response.ok) {
        throwLedgerError(response)
      }
      return response.result as LedgerResponse
    }
  }
}
